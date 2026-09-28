import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, request } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeProxyUnsupportedReason, runClaude, startClaudeProxy } from '../dist/claude-proxy.js';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

function post(url, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(path, url);
    const req = request(target, { method: 'POST', headers: { 'content-length': Buffer.byteLength(body), ...headers } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.once('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

test('Claude gateway forwards Anthropic traffic unchanged and records streaming usage', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jev-claude-proxy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let seen;
  const upstream = createServer(async (req, res) => {    let body = '';
    for await (const chunk of req) body += chunk;
    seen = { url: req.url, auth: req.headers.authorization, dropped: req.headers['x-drop-me'], proxyAuth: req.headers['proxy-authorization'], body };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const first = Buffer.from('event: message_start\ndata: {"type":"message_start","message":{"model":"claude-tést","usage":{"input_tokens":120,"cache_creation_input_tokens":30,"cache_read_input_tokens":70}}}\n\n');
    const split = first.indexOf(Buffer.from('é')) + 1;
    res.write(first.subarray(0, split));
    res.write(first.subarray(split));
    res.end('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":11}}\n\n');
  });
  const port = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const env = { JEVCOMP_DATA_DIR: join(root, 'data'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/anthropic` };
  const proxy = await startClaudeProxy(env);
  t.after(() => proxy.close());
  const body = '{"model":"claude-test","messages":[{"role":"user","content":"hello"}]}';
  const response = await post(proxy.baseUrl, '/v1/messages?beta=true', body, { authorization: 'Bearer secret', connection: 'x-drop-me', 'x-drop-me': 'secret', 'proxy-authorization': 'Basic secret' });

  assert.equal(response.status, 200);
  assert.match(response.text, /message_start/);
  assert.deepEqual(seen, { url: '/anthropic/v1/messages?beta=true', auth: 'Bearer secret', dropped: undefined, proxyAuth: undefined, body });

  let rows;
  for (let i = 0; i < 20; i++) {
    try { rows = (await readFile(join(root, 'data', 'claude-usage.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    at: rows[0].at,
    model: 'claude-tést',
    path: '/anthropic/v1/messages',
    statusCode: 200,
    durationMs: rows[0].durationMs,
    inputTokens: 120,
    cacheCreationInputTokens: 30,
    cacheReadInputTokens: 70,
    outputTokens: 11,
  });
});

test('Claude gateway wrapper preserves args and only replaces ANTHROPIC_BASE_URL', async () => {
  const child = new EventEmitter();
  let spawned;
  let closed = false;
  const env = { ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic', KEEP_ME: 'yes' };
  const exit = runClaude(['--model', 'sonnet'], env, {
    startProxy: async () => ({ baseUrl: 'http://127.0.0.1:43210', upstream: env.ANTHROPIC_BASE_URL, close: async () => { closed = true; } }),
    spawn: (name, args, options) => {
      spawned = { name, args, options };
      queueMicrotask(() => child.emit('close', 7, null));
      return child;
    },
  });
  assert.equal(await exit, 7);
  assert.equal(spawned.name, 'claude');
  assert.deepEqual(spawned.args, ['--model', 'sonnet']);
  assert.equal(spawned.options.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:43210');
  assert.equal(spawned.options.env.KEEP_ME, 'yes');
  assert.equal(closed, true);
});test('Claude gateway fails open for provider routes it cannot safely proxy', async () => {
  assert.match(claudeProxyUnsupportedReason({ CLAUDE_CODE_USE_BEDROCK: 'true' }), /Bedrock/);
  assert.equal(claudeProxyUnsupportedReason({ CLAUDE_CODE_USE_BEDROCK: 'false' }), undefined);
  assert.match(claudeProxyUnsupportedReason({ ANTHROPIC_VERTEX_BASE_URL: 'https://vertex.example' }), /Vertex/);
  assert.match(claudeProxyUnsupportedReason({ CLAUDE_CODE_USE_FOUNDRY: '1' }), /Foundry/);
  assert.match(claudeProxyUnsupportedReason({ CLAUDE_CODE_USE_ANTHROPIC_AWS: '1' }), /AWS/);
  assert.match(claudeProxyUnsupportedReason({ CLAUDE_CODE_USE_MANTLE: '1' }), /Mantle/);
  assert.match(claudeProxyUnsupportedReason({ CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1' }), /managed by the host/);
  assert.match(claudeProxyUnsupportedReason({ HTTPS_PROXY: 'http://proxy.example:8080' }), /corporate proxy/);

  const child = new EventEmitter();
  let proxyStarted = false;
  let spawned;
  const env = { HTTPS_PROXY: 'http://proxy.example:8080', ANTHROPIC_BASE_URL: 'https://api.anthropic.com' };
  const code = await runClaude(['-p', 'hi'], env, {
    startProxy: async () => { proxyStarted = true; throw new Error('should not run'); },
    spawn: (name, args, options) => {
      spawned = { name, args, options };
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  });
  assert.equal(code, 0);
  assert.equal(proxyStarted, false);
  assert.equal(spawned.options.env, env);
});


test('Claude gateway records usage from non-streaming JSON responses without changing the body', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jev-claude-json-proxy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const responseBody = JSON.stringify({
    id: 'msg_1',
    model: 'claude-json',
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 9, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 },
  });
  const upstream = createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(responseBody) });
    res.end(responseBody);
  });
  const port = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));

  const env = { JEVCOMP_DATA_DIR: join(root, 'data'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` };
  const proxy = await startClaudeProxy(env);
  t.after(() => proxy.close());
  const response = await post(proxy.baseUrl, '/v1/messages', '{}');
  assert.equal(response.text, responseBody);

  let row;
  for (let i = 0; i < 20; i++) {
    try {
      row = JSON.parse((await readFile(join(root, 'data', 'claude-usage.jsonl'), 'utf8')).trim());
      break;
    } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  assert.equal(row.model, 'claude-json');
  assert.equal(row.inputTokens, 9);
  assert.equal(row.cacheCreationInputTokens, 2);
  assert.equal(row.cacheReadInputTokens, 3);
  assert.equal(row.outputTokens, 4);
});
