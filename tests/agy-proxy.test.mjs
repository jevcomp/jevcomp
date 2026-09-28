import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer, connect as connectTcp } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAgyCertificate, isAgyInterceptHost, runAgy, startAgyProxy } from '../dist/agy-proxy.js';

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}

test('Antigravity proxy tunnels other CONNECT hosts without decrypting their bytes', async (t) => {
  const target = createNetServer(socket => socket.pipe(socket));
  const targetPort = await listen(target);
  t.after(() => new Promise(resolve => target.close(resolve)));
  const root = await mkdtemp(join(tmpdir(), 'jev-agy-tunnel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proxy = await startAgyProxy({ JEVCOMP_AGY_HOME: root }, { tunnelHost: '127.0.0.1', tunnelPort: targetPort });
  t.after(() => proxy.close());
  const port = Number(new URL(proxy.url).port);
  const client = connectTcp(port, '127.0.0.1');
  const received = [];
  client.on('data', chunk => received.push(chunk));
  await new Promise(resolve => client.once('connect', resolve));
  client.write('CONNECT private.example:8443 HTTP/1.1\r\nHost: private.example:8443\r\n\r\nopaque-tunnel-data');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.match(Buffer.concat(received).toString(), /200 Connection Established/);
  assert.match(Buffer.concat(received).toString(), /opaque-tunnel-data/);
  client.destroy();
});

test('missing OpenSSL reports the install command', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jev-agy-no-openssl-'));
  const path = join(root, 'empty-path');
  await mkdir(path);
  t.after(() => rm(root, { recursive: true, force: true }));

  const pathVariable = Object.keys(process.env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
  await assert.rejects(ensureAgyCertificate({
    ...process.env,
    JEVCOMP_AGY_HOME: join(root, 'ca'),
    JEVCOMP_OPENSSL: join(root, 'missing-openssl.exe'),
    [pathVariable]: path,
  }), {
    message: 'openssl was not found; install it first (for example: winget install ShiningLight.OpenSSL.Light)',
  });
});

test('TLS interception is restricted to both model hosts and capture stores only the generation body', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jev-agy-tls-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { JEVCOMP_AGY_HOME: root, JEVCOMP_DATA_DIR: root, JEVCOMP_CAPTURE: '1' };
  const certs = await ensureAgyCertificate(env);
  const ca = await readFile(join(certs.directory, 'ca.crt'));
  const key = await readFile(join(certs.directory, 'server.key'));
  const cert = await readFile(join(certs.directory, 'server.crt'));
  let receivedBody;
  const upstream = createHttpsServer({ key, cert }, (req, res) => {
    const parts = [];
    req.on('data', chunk => parts.push(chunk));
    req.on('end', () => { receivedBody = Buffer.concat(parts).toString(); res.end('upstream-ok'); });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const proxy = await startAgyProxy(env, { upstreamHost: '127.0.0.1', upstreamPort, upstreamCa: ca });
  t.after(() => proxy.close());
  assert.equal(isAgyInterceptHost('cloudcode-pa.googleapis.com'), true);
  assert.equal(isAgyInterceptHost('daily-cloudcode-pa.googleapis.com'), true);
  assert.equal(isAgyInterceptHost('accounts.google.com'), false);

  for (const hostname of ['cloudcode-pa.googleapis.com', 'daily-cloudcode-pa.googleapis.com']) {
    const socket = connectTcp(Number(new URL(proxy.url).port), '127.0.0.1');
    await new Promise(resolve => socket.once('connect', resolve));
    socket.write(`CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\n\r\n`);
    const responseText = await new Promise((resolve, reject) => {
      let response = Buffer.alloc(0);
      const onData = chunk => {
        response = Buffer.concat([response, chunk]);
        if (!response.includes(Buffer.from('\r\n\r\n'))) return;
        socket.off('data', onData);
        if (!response.toString().startsWith('HTTP/1.1 200')) return reject(new Error('CONNECT denied'));
        const tls = connectTls({ socket, servername: hostname, ca });
        tls.once('secureConnect', () => {
          tls.write('POST /v1internal:streamGenerateContent?alt=sse HTTP/1.1\r\nHost: ' + hostname + '\r\nContent-Length: 14\r\nConnection: close\r\n\r\nsecret-payload');
          let response = '';
          tls.on('data', chunk => { response += chunk.toString(); });
          tls.once('end', () => resolve(response));
        });
        tls.once('error', reject);
      };
      socket.on('data', onData);
    });
    socket.destroy();
    assert.match(responseText, /upstream-ok/);
  }
  assert.equal(receivedBody, 'secret-payload');
  const captureDir = join(root, 'agy-capture');
  const captures = await readdir(captureDir);
  assert.equal(captures.length, 2);
  assert.equal((await readFile(join(captureDir, captures[0]), 'utf8')), 'secret-payload');
});

test('Antigravity generation requests are Jev-compacted before forwarding and content-length is repaired', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jev-agy-compact-proxy-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const jev = createHttpServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const questions = JSON.parse(body).questions;
    const answers = Object.fromEntries(Object.keys(questions).map((key) => [
      key,
      { noul: key.startsWith('drop_') ? 0.9 : 0.1 },
    ]));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ answers }));
  });
  const jevPort = await listen(jev);
  t.after(() => new Promise(resolve => jev.close(resolve)));

  const env = {
    ...process.env,
    JEVCOMP_AGY_HOME: join(root, 'ca'),
    JEVCOMP_DATA_DIR: join(root, 'data'),
    JEVCOMP_CONFIG_DIR: join(root, 'config'),
    JEVCOMP_PROVIDER: 'typesafe',
    TYPESAFE_API_KEY: 'test',
    JEV_BASE_URL: `http://127.0.0.1:${jevPort}`,
    JEVCOMP_RETRIES: '0',
    JEVCOMP_PIN_RECENT_MESSAGES: '0',
    JEVCOMP_MIN_REDUCTION_RATIO: '0',
    JEVCOMP_AGY_MIN_ELIGIBLE_CHARS: '0',
  };
  const certs = await ensureAgyCertificate(env);
  const ca = await readFile(join(certs.directory, 'ca.crt'));
  const key = await readFile(join(certs.directory, 'server.key'));
  const cert = await readFile(join(certs.directory, 'server.crt'));

  let receivedBody = '';
  let receivedLength = '';
  const upstream = createHttpsServer({ key, cert }, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    receivedBody = Buffer.concat(chunks).toString();
    receivedLength = String(req.headers['content-length'] ?? '');
    res.end('upstream-ok');
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const proxy = await startAgyProxy(env, { upstreamHost: '127.0.0.1', upstreamPort, upstreamCa: ca });
  t.after(() => proxy.close());

  const payload = {
    project: 'p',
    model: 'gemini-test',
    requestId: 'r1',
    request: {
      sessionId: 'stable-session',
      contents: [
        { role: 'user', parts: [{ text: 'diagnose the test failure' }] },
        { role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'shell', args: { command: 'npm test' } }, thoughtSignature: 'signature-stays' }] },
        { role: 'user', parts: [{ functionResponse: { id: 'call_1', name: 'shell', response: { result: 'HEAD\\n' + 'noise '.repeat(1000) + '\\nTAIL ERROR' } } }] },
        { role: 'model', parts: [{ text: 'continue' }] },
      ],
    },
  };
  const raw = JSON.stringify(payload);
  const socket = connectTcp(Number(new URL(proxy.url).port), '127.0.0.1');
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write('CONNECT cloudcode-pa.googleapis.com:443 HTTP/1.1\r\nHost: cloudcode-pa.googleapis.com:443\r\n\r\n');

  const responseText = await new Promise((resolve, reject) => {
    let response = Buffer.alloc(0);
    const onData = chunk => {
      response = Buffer.concat([response, chunk]);
      if (!response.includes(Buffer.from('\r\n\r\n'))) return;
      socket.off('data', onData);
      if (!response.toString().startsWith('HTTP/1.1 200')) return reject(new Error('CONNECT denied'));
      const tls = connectTls({ socket, servername: 'cloudcode-pa.googleapis.com', ca });
      tls.once('secureConnect', () => {
        tls.write(
          'POST /v1internal:streamGenerateContent?alt=sse HTTP/1.1\r\n' +
          'Host: cloudcode-pa.googleapis.com\r\n' +
          'Content-Type: application/json\r\n' +
          `Content-Length: ${Buffer.byteLength(raw)}\r\n` +
          'Connection: close\r\n\r\n' +
          raw,
        );
        let text = '';
        tls.on('data', chunk => { text += chunk.toString(); });
        tls.once('end', () => resolve(text));
      });
      tls.once('error', reject);
    };
    socket.on('data', onData);
  });
  socket.destroy();

  assert.match(responseText, /upstream-ok/);
  const forwarded = JSON.parse(receivedBody);
  const resultText = forwarded.request.contents[2].parts[0].functionResponse.response.result;
  assert.ok(resultText.length < payload.request.contents[2].parts[0].functionResponse.response.result.length);
  assert.match(resultText, /^HEAD/);
  assert.match(resultText, /TAIL ERROR$/);
  assert.equal(forwarded.request.contents[1].parts[0].thoughtSignature, 'signature-stays');
  assert.equal(receivedLength, String(Buffer.byteLength(receivedBody)));

  const history = (await readFile(join(root, 'data', 'history.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(history.length, 2);
  assert.equal(history[0].host, 'agy');
  assert.equal(history[0].status, 'prepared');
  assert.equal(history[1].phase, 'postcompact');
  assert.equal(history[1].status, 'restored');
});

test('agy forwards arguments, inherited streams, proxy environment and exit status', async () => {
  let invocation, closed = false, dashboardAttempted = false;
  const env = { PATH: process.env.PATH };
  const status = await runAgy(['--model', 'name with spaces'], env, {
    isInstalled: () => true,
    startDashboard: async () => { dashboardAttempted = true; },
    startProxy: async () => ({ url: 'http://127.0.0.1:32100', close: async () => { closed = true; } }),
    spawn: (command, args, options) => {
      invocation = { command, args, options };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 23, null));
      return child;
    },
  });
  assert.equal(status, 23);
  assert.equal(invocation.command, 'agy');
  assert.deepEqual(invocation.args, ['--model', 'name with spaces']);
  assert.equal(invocation.options.stdio, 'inherit');
  assert.equal(invocation.options.env.HTTPS_PROXY, 'http://127.0.0.1:32100');
  assert.equal(dashboardAttempted, true);
  assert.equal(closed, true);
});

test('agy starts without the proxy when its certificate is not installed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jev-agy-untrusted-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let env;
  const status = await runAgy(['-p', 'oi'], { JEVCOMP_AGY_HOME: root }, {
    isInstalled: () => false,
    startProxy: () => { throw new Error('proxy must not start'); },
    spawn: (_command, _args, options) => {
      env = options.env;
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  });
  assert.equal(status, 0);
  assert.equal(env.HTTPS_PROXY, undefined);
});
