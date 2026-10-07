import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { isCodexCompactionRequest, startCodexProxy } from '../dist/codex-proxy.js';
import { codexCompactionReductionRatio, renderCodexCompactionSummary } from '../dist/codex-compaction.js';
import { configureAudit, auditRoot } from '../dist/audit-store.js';
import { auditManifests } from '../dist/audit.js';

const compactionFixture = JSON.parse(await readFile(new URL('./fixtures/codex-compaction-request.json', import.meta.url), 'utf8'));

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function collect(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function makeCodexHome(auth) {
  const root = await mkdtemp(join(tmpdir(), 'jev-codex-proxy-'));
  await writeFile(join(root, 'auth.json'), JSON.stringify(auth));
  return root;
}

test('ChatGPT auth forwards account headers and captures only the JSON body while streaming', async (t) => {
  let received;
  let responseComplete = false;
  let releaseSecondChunk;
  const secondChunk = new Promise((resolve) => { releaseSecondChunk = resolve; });
  const upstream = createServer(async (request, response) => {
    received = { url: request.url, headers: request.headers, body: await collect(request) };
    response.writeHead(200, { 'content-type': 'text/event-stream', 'x-upstream': 'mock' });
    response.write('data: first\n\n');
    await secondChunk;
    response.end('data: second\n\n');
    responseComplete = true;
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => close(upstream));

  const codexHome = await makeCodexHome({ auth_mode: 'chatgpt', tokens: { account_id: 'private-account' } });
  const captureDir = join(codexHome, 'capture');
  const proxy = await startCodexProxy({ CODEX_HOME: codexHome, JEVCOMP_CAPTURE: captureDir }, {
    chatgpt: `${upstreamUrl}/backend-api/codex`,
    api: `${upstreamUrl}/v1`,
  });
  t.after(async () => { await proxy.close(); await rm(codexHome, { recursive: true, force: true }); });

  const body = JSON.stringify({ stream: true, input: [{ role: 'user', content: 'hello' }] });
  const response = await fetch(`${proxy.baseUrl}/responses?trace=1`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer private-token',
      'chatgpt-account-id': 'account-header',
      'content-type': 'application/json',
      'x-forwarded-test': 'present',
    },
    body,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-upstream'), 'mock');

  const reader = response.body.getReader();
  let timeout;
  let streamed = '';
  try {
    const firstChunk = await Promise.race([
      reader.read(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('response was buffered')), 2000); }),
    ]);
    assert.equal(firstChunk.done, false);
    assert.match(new TextDecoder().decode(firstChunk.value), /data: first/);
    assert.equal(responseComplete, false);
    streamed = new TextDecoder().decode(firstChunk.value);
    releaseSecondChunk();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      streamed += new TextDecoder().decode(chunk.value);
    }
  } finally {
    clearTimeout(timeout);
    releaseSecondChunk();
  }
  assert.match(streamed, /data: second/);
  assert.equal(responseComplete, true);

  assert.equal(received.url, '/backend-api/codex/responses?trace=1');
  assert.equal(received.headers.authorization, 'Bearer private-token');
  assert.equal(received.headers['chatgpt-account-id'], 'account-header');
  assert.equal(received.headers['x-forwarded-test'], 'present');
  assert.equal(received.body, body);

  const files = await readdir(captureDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /\.json$/);
  const captured = await readFile(join(captureDir, files[0]), 'utf8');
  assert.equal(captured, body);
  assert.deepEqual(JSON.parse(captured), JSON.parse(body));
  assert.equal(captured.includes('private-token'), false);
});

test('API-key auth routes responses to the OpenAI API base and captures POSTs only', async (t) => {
  const paths = [];
  const upstream = createServer(async (request, response) => {
    paths.push(request.url);
    await collect(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => close(upstream));

  const codexHome = await makeCodexHome({ auth_mode: 'apikey', OPENAI_API_KEY: 'do-not-forward-from-file' });
  const captureDir = join(codexHome, 'capture');
  await mkdir(captureDir);
  const proxy = await startCodexProxy({ CODEX_HOME: codexHome, JEVCOMP_CAPTURE: captureDir }, {
    chatgpt: `${upstreamUrl}/backend-api/codex`,
    api: `${upstreamUrl}/v1`,
  });
  t.after(async () => { await proxy.close(); await rm(codexHome, { recursive: true, force: true }); });

  const responseBody = JSON.stringify({ input: 'api-key request' });
  const response = await fetch(`${proxy.baseUrl}/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer api-key', 'content-type': 'application/json' },
    body: responseBody,
  });
  assert.deepEqual(await response.json(), { ok: true });
  await fetch(`${proxy.baseUrl}/models`);
  assert.deepEqual(paths, ['/v1/responses', '/v1/models']);

  const files = await readdir(captureDir);
  assert.equal(files.length, 1);
  assert.equal(await readFile(join(captureDir, files[0]), 'utf8'), responseBody);
});

test('capture failures fail open and still forward the request', async (t) => {
  let received;
  const upstream = createServer(async (request, response) => {
    received = { url: request.url, body: await collect(request) };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"forwarded":true}');
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => close(upstream));

  const codexHome = await makeCodexHome({ auth_mode: 'apikey' });
  const capturePath = join(codexHome, 'capture-is-a-file');
  await writeFile(capturePath, 'block directory creation');
  const proxy = await startCodexProxy({ CODEX_HOME: codexHome, JEVCOMP_CAPTURE: capturePath }, {
    chatgpt: `${upstreamUrl}/backend-api/codex`,
    api: `${upstreamUrl}/v1`,
  });
  t.after(async () => { await proxy.close(); await rm(codexHome, { recursive: true, force: true }); });

  const body = JSON.stringify({ stream: true, input: 'forward despite capture failure' });
  const response = await fetch(`${proxy.baseUrl}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { forwarded: true });
  assert.deepEqual(received, { url: '/v1/responses', body });
});

test('decompressed gzip and brotli responses omit content-encoding', async (t) => {
  const decoded = 'decoded upstream text';
  const encoded = new Map([
    ['gzip', gzipSync(decoded)],
    ['br', brotliCompressSync(decoded)],
  ]);
  const upstream = createServer((request, response) => {
    const encoding = new URL(request.url, 'http://127.0.0.1').searchParams.get('encoding');
    response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': encoding });
    response.end(encoded.get(encoding));
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => close(upstream));

  const codexHome = await makeCodexHome({ auth_mode: 'apikey' });
  const proxy = await startCodexProxy({ CODEX_HOME: codexHome }, {
    chatgpt: `${upstreamUrl}/backend-api/codex`,
    api: `${upstreamUrl}/v1`,
  });
  t.after(async () => { await proxy.close(); await rm(codexHome, { recursive: true, force: true }); });

  for (const encoding of encoded.keys()) {
    const response = await fetch(`${proxy.baseUrl}/responses?encoding=${encoding}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(await response.text(), decoded);
  }
});

test('uses Codex turn metadata before the legacy compaction prompt fallback', () => {
  assert.equal(isCodexCompactionRequest(compactionFixture), true);

  const similar = structuredClone(compactionFixture);
  similar.input.at(-1).content[0].text += ' ';
  assert.equal(isCodexCompactionRequest(similar), false);

  const metadataCompaction = structuredClone(similar);
  metadataCompaction.client_metadata['x-codex-turn-metadata'] = JSON.stringify({
    request_kind: 'compaction',
    compaction: { implementation: 'responses' },
  });
  assert.equal(isCodexCompactionRequest(metadataCompaction), true);

  const ordinaryTurn = structuredClone(compactionFixture);
  ordinaryTurn.client_metadata['x-codex-turn-metadata'] = JSON.stringify({ request_kind: 'turn' });
  assert.equal(isCodexCompactionRequest(ordinaryTurn), false);

  const remoteV2 = structuredClone(compactionFixture);
  remoteV2.client_metadata['x-codex-turn-metadata'] = JSON.stringify({
    request_kind: 'compaction',
    compaction: { implementation: 'responses_compaction_v2' },
  });
  assert.equal(isCodexCompactionRequest(remoteV2), false);

  const incompleteMetadata = structuredClone(similar);
  incompleteMetadata.client_metadata['x-codex-turn-metadata'] = JSON.stringify({
    request_kind: 'compaction',
    compaction: {},
  });
  assert.equal(isCodexCompactionRequest(incompleteMetadata), false);

  const legacyWithIncompleteMetadata = structuredClone(compactionFixture);
  legacyWithIncompleteMetadata.client_metadata['x-codex-turn-metadata'] = JSON.stringify({
    request_kind: 'compaction',
    compaction: {},
  });
  assert.equal(isCodexCompactionRequest(legacyWithIncompleteMetadata), true);

  const followedByAnotherItem = structuredClone(compactionFixture);
  followedByAnotherItem.input.push({ type: 'message', role: 'user', content: 'ordinary message' });
  assert.equal(isCodexCompactionRequest(followedByAnotherItem), false);
});

test('Codex summaries omit only user messages fully preserved by replacement history', () => {
  const small = [
    { role: 'user', text: 'binding user constraint', toolCalls: [] },
    { role: 'assistant', text: 'assistant progress', toolCalls: [] },
  ];
  const smallSummary = renderCodexCompactionSummary(small);
  assert.doesNotMatch(smallSummary, /binding user constraint/);
  assert.match(smallSummary, /assistant progress/);

  const oldConstraint = 'old user constraint that would otherwise be lost';
  const recent = 'r'.repeat(80_000);
  const overflow = [
    { role: 'user', text: oldConstraint, toolCalls: [] },
    { role: 'assistant', text: 'middle progress', toolCalls: [] },
    { role: 'user', text: recent, toolCalls: [] },
  ];
  const overflowSummary = renderCodexCompactionSummary(overflow);
  assert.match(overflowSummary, /old user constraint that would otherwise be lost/);
  assert.equal(overflowSummary.includes(recent.slice(0, 200)), false);
});

test('Codex reduction ignores text that Codex preserves outside the synthetic summary', () => {
  const hugeUser = { role: 'user', text: 'u'.repeat(40_000), toolCalls: [] };
  const call = { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'read', input: { path: 'a' } }] };
  const result = { role: 'tool', text: '', toolCalls: [], toolResults: [{ callId: 'c1', output: 'x'.repeat(4000) }] };
  const before = [hugeUser, call, result];
  const after = [hugeUser, call, { ...result, toolResults: [{ callId: 'c1', output: 'short' }] }];
  assert.ok(codexCompactionReductionRatio(before, after) > 0.9);
});

test('answers a matching compact request with accepted SSE and records it in history', async (t) => {
  let upstreamHit = false;
  const upstream = createServer(async (request, response) => {
    upstreamHit = true;
    await collect(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"forwarded":true}');
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => close(upstream));

  const codexHome = await makeCodexHome({ auth_mode: 'apikey' });
  const dataDir = join(codexHome, 'jev-data');
  await configureAudit({ JEVCOMP_DATA_DIR: dataDir }, 'codex', 'evidence');
  const proxy = await startCodexProxy({
    CODEX_HOME: codexHome,
    JEVCOMP_DATA_DIR: dataDir,
    JEVCOMP_MIN_REDUCTION_RATIO: '0',
    JEVCOMP_PROVIDER: 'typesafe',
  }, {
    chatgpt: `${upstreamUrl}/backend-api/codex`,
    api: `${upstreamUrl}/v1`,
  });
  t.after(async () => { await proxy.close(); await rm(codexHome, { recursive: true, force: true }); });

  const canonicalRequest = structuredClone(compactionFixture);
  canonicalRequest.client_metadata = {
    'x-codex-turn-metadata': JSON.stringify({
      request_kind: 'compaction',
      session_id: 'canonical-session',
      thread_id: 'canonical-thread',
      turn_id: 'canonical-turn',
      compaction: { implementation: 'responses' },
    }),
  };
  canonicalRequest.input.at(-1).content[0].text = 'custom compaction instruction';
  const response = await fetch(`${proxy.baseUrl}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(canonicalRequest),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const stream = await response.text();
  const events = stream.trim().split(/\r?\n\r?\n/).map((block) => {
    const event = block.match(/^event: (.+)$/m)?.[1];
    const data = block.match(/^data: (.+)$/m)?.[1];
    return { event, data: JSON.parse(data) };
  });

  assert.deepEqual(events.map(({ event }) => event), [
    'response.created', 'response.output_item.done', 'response.completed',
  ]);
  assert.equal(events[1].data.item.type, 'message');
  assert.equal(events[1].data.item.role, 'assistant');
  assert.equal(events[1].data.item.content[0].type, 'output_text');
  assert.doesNotMatch(events[1].data.item.content[0].text, /Fixture user request/);
  assert.match(events[1].data.item.content[0].text, /Fixture assistant response/);
  assert.match(events[1].data.item.content[0].text, /Fixture tool output/);
  assert.ok(events[2].data.response.usage.output_tokens > 0);
  assert.equal(events[2].data.response.usage.total_tokens, events[2].data.response.usage.output_tokens);
  assert.equal(upstreamHit, false);

  const history = (await readFile(join(dataDir, 'history.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(history.length, 2);
  assert.equal(history[0].host, 'codex');
  assert.equal(history[0].phase, 'precompact');
  assert.equal(history[0].status, 'prepared');
  assert.equal(history[0].sessionId, 'canonical-session');
  assert.equal(history[0].turnId, 'canonical-turn');
  assert.equal(history[1].status, 'restored');
  assert.equal(history[1].runId, history[0].runId);
  const audits = await auditManifests({ JEVCOMP_DATA_DIR: dataDir });
  assert.equal(audits.manifests.length, 1);
  assert.equal(audits.manifests[0].stage, 'result_produced');
  assert.equal(audits.manifests[0].sessionId, 'canonical-session');
  assert.ok(audits.manifests[0].outputHash);
  assert.equal(history[0].auditId, audits.manifests[0].id);
});

test('Codex audit records evaluated cuts rejected by the minimum and forwards native compaction', async (t) => {
  let forwardedBody;
  const upstream = createServer(async (request, response) => {
    forwardedBody = await collect(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"native":true}');
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => close(upstream));
  const codexHome = await makeCodexHome({ auth_mode: 'apikey' });
  const env = { CODEX_HOME: codexHome, JEVCOMP_DATA_DIR: join(codexHome, 'data'), JEVCOMP_MIN_REDUCTION_RATIO: '1', JEVCOMP_PROVIDER: 'typesafe' };
  await configureAudit(env, 'codex', 'metadata');
  const proxy = await startCodexProxy(env, { chatgpt: `${upstreamUrl}/backend-api/codex`, api: `${upstreamUrl}/v1` });
  t.after(() => proxy.close());
  const response = await fetch(`${proxy.baseUrl}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(compactionFixture) });
  assert.deepEqual(await response.json(), { native: true });
  assert.deepEqual(JSON.parse(forwardedBody), compactionFixture);
  const { manifests } = await auditManifests(env);
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].stage, 'rejected');
  assert.equal(manifests[0].reason, 'below_minimum');
  assert.equal(manifests[0].historyRecorded, true);
});

test('fails open for compact requests that throw, produce no text, or exceed the summary limit', async (t) => {
  const receivedBodies = [];
  const upstream = createServer(async (request, response) => {
    receivedBodies.push(await collect(request));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"forwarded":true}');
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => close(upstream));

  const codexHome = await makeCodexHome({ auth_mode: 'apikey' });
  const proxy = await startCodexProxy({
    CODEX_HOME: codexHome,
    JEVCOMP_DATA_DIR: join(codexHome, 'jev-data'),
    JEVCOMP_MIN_REDUCTION_RATIO: '0',
    JEVCOMP_PROVIDER: 'typesafe',
  }, {
    chatgpt: `${upstreamUrl}/backend-api/codex`,
    api: `${upstreamUrl}/v1`,
  });
  t.after(async () => { await proxy.close(); await rm(codexHome, { recursive: true, force: true }); });

  const finalPrompt = structuredClone(compactionFixture.input.at(-1));
  const cases = [
    {
      input: [...compactionFixture.input.slice(0, -1), { type: 'custom_tool_call_output', call_id: 'image', output: [{ type: 'input_image', image_url: 'data:image/png;base64,test' }] }, finalPrompt],
    },
    {
      input: [...compactionFixture.input.slice(0, -1), { type: 'image_generation_call' }, finalPrompt],
    },
    {
      input: [compactionFixture.input[0], finalPrompt],
    },
    {
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'word '.repeat(18_010) }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'fixture response' }] },
        finalPrompt,
      ],
    },
  ].map((value) => JSON.stringify({ ...compactionFixture, ...value }));

  for (const body of cases) {
    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.deepEqual(await response.json(), { forwarded: true });
  }

  assert.deepEqual(receivedBodies, cases);
  const history = (await readFile(join(codexHome, 'jev-data', 'history.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(history[0].status, 'failed');
  assert.equal(history[0].phase, 'precompact');
  assert.match(history[0].detail, /non-text tool output/);
  assert.equal(history[1].status, 'failed');
  assert.match(history[1].detail, /image generation/);
});

test('a bridge set as openai_base_url in config.toml receives the forwarded traffic', async (t) => {
  let receivedUrl;
  const bridge = createServer(async (request, response) => {
    receivedUrl = request.url;
    await collect(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  const bridgeUrl = await listen(bridge);
  t.after(() => close(bridge));
  const codexHome = await makeCodexHome({ auth_mode: 'chatgpt', tokens: { account_id: 'a' } });
  await writeFile(join(codexHome, 'config.toml'), `model = "bridge/model"\nopenai_base_url = "${bridgeUrl}/v1" # managed\n[model_providers.other]\nopenai_base_url = "http://wrong"\n`);
  const proxy = await startCodexProxy({ CODEX_HOME: codexHome });
  t.after(async () => { await proxy.close(); await rm(codexHome, { recursive: true, force: true }); });

  const response = await fetch(`${proxy.baseUrl}/responses`, { method: 'POST', headers: { 'chatgpt-account-id': 'a' }, body: JSON.stringify({ input: [] }) });
  assert.equal(response.status, 200);
  assert.equal(receivedUrl, '/v1/responses');
});
