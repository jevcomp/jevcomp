import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as connectTcp } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAgyOutbound, createAgyAuditJournalState } from '../dist/agy-audit.js';
import { ensureAgyCertificate, startAgyProxy } from '../dist/agy-proxy.js';
import { analyzeAudit, auditReport, simulateAudit } from '../dist/audit-analysis.js';
import { auditCommand } from '../dist/audit-cli.js';
import { auditManifests } from '../dist/audit.js';
import { auditRoot, configureAudit, digest } from '../dist/audit-store.js';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function postGeneration(proxyUrl, ca, raw) {
  const socket = connectTcp(Number(new URL(proxyUrl).port), '127.0.0.1');
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write('CONNECT cloudcode-pa.googleapis.com:443 HTTP/1.1\r\nHost: cloudcode-pa.googleapis.com:443\r\n\r\n');
  return new Promise((resolve, reject) => {
    let connectResponse = Buffer.alloc(0);
    const onData = chunk => {
      connectResponse = Buffer.concat([connectResponse, chunk]);
      if (!connectResponse.includes(Buffer.from('\r\n\r\n'))) return;
      socket.off('data', onData);
      if (!connectResponse.toString().startsWith('HTTP/1.1 200')) return reject(new Error('CONNECT denied'));
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
        let response = '';
        tls.on('data', chunk => { response += chunk.toString(); });
        tls.once('end', () => resolve(response));
      });
      tls.once('error', reject);
    };
    socket.on('data', onData);
    socket.once('error', reject);
  }).finally(() => socket.destroy());
}

function generationPayload() {
  return {
    project: 'audit-project',
    model: 'gemini-audit',
    requestId: 'audit-request',
    request: {
      sessionId: 'agy-audit-session',
      contents: [
        { role: 'user', parts: [{ text: 'diagnose the failing build' }] },
        { role: 'model', parts: [{
          functionCall: { id: 'call_1', name: 'run_command', args: { command: 'npm test' } },
          thoughtSignature: 'signature-must-stay',
        }] },
        { role: 'user', parts: [{
          functionResponse: {
            id: 'call_1',
            name: 'run_command',
            response: { output: 'HEAD\n' + 'diagnostic-noise '.repeat(600) + '\nTAIL FAILURE' },
          },
        }] },
        { role: 'model', parts: [{ text: 'I will inspect the failure.' }] },
      ],
    },
  };
}

async function harness(t, mode = 'evidence', jevStatus = 200, transportFailure = false, minReductionRatio = '0', answerForKey = () => 0.1) {
  const root = await mkdtemp(join(tmpdir(), 'jev-agy-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let jevCalls = 0;
  const jev = createHttpServer(async (req, res) => {
    jevCalls++;
    let body = '';
    for await (const chunk of req) body += chunk;
    const questions = JSON.parse(body).questions;
    if (jevStatus !== 200) {
      res.statusCode = jevStatus;
      res.end('provider-failure');
      return;
    }
    const answers = Object.fromEntries(Object.keys(questions).map(key => [key, { noul: answerForKey(key) }]));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ answers, usage: { input_tokens: 123, output_tokens: 4 } }));
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
    JEVCOMP_MIN_REDUCTION_RATIO: minReductionRatio,
    JEVCOMP_AGY_MIN_ELIGIBLE_CHARS: '0',
  };
  await configureAudit(env, 'agy', mode);
  const certs = await ensureAgyCertificate(env);
  const ca = await readFile(join(certs.directory, 'ca.crt'));
  const key = await readFile(join(certs.directory, 'server.key'));
  const cert = await readFile(join(certs.directory, 'server.crt'));
  const forwarded = [];
  const upstream = createHttpsServer({ key, cert }, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    forwarded.push(Buffer.concat(chunks).toString());
    res.end('upstream-ok');
  });
  const upstreamPort = await listen(upstream);
  if (transportFailure) await new Promise(resolve => upstream.close(resolve));
  else t.after(() => new Promise(resolve => upstream.close(resolve)));

  const proxy = await startAgyProxy(env, {
    upstreamHost: '127.0.0.1',
    upstreamPort,
    upstreamCa: ca,
  });
  t.after(() => proxy.close());
  return { root, env, ca, proxy, forwarded, jevCalls: () => jevCalls };
}

test('Antigravity audit records the Jev decision, host projection and confirmed outbound', async (t) => {
  const h = await harness(t);
  const raw = JSON.stringify(generationPayload());
  assert.match(await postGeneration(h.proxy.url, h.ca, raw), /upstream-ok/);
  assert.equal(h.jevCalls(), 1);
  const outbound = JSON.parse(h.forwarded[0]);
  const callPart = outbound.request.contents[1].parts[0];
  const result = outbound.request.contents[2].parts[0].functionResponse.response.output;
  assert.equal(callPart.thoughtSignature, 'signature-must-stay');
  assert.equal(callPart.functionCall.id, 'call_1');
  assert.match(result, /jevcomp omitted/);
  assert.ok(result.length < generationPayload().request.contents[2].parts[0].functionResponse.response.output.length);

  const { manifests, corrupt } = await auditManifests(h.env);
  assert.deepEqual(corrupt, []);
  assert.equal(manifests.length, 1);
  const manifest = manifests[0];
  assert.equal(manifest.agent, 'agy');
  assert.equal(manifest.sessionSource, 'proxy');
  assert.equal(manifest.adapterPolicy, 'agy-preserve-call-result-only-v1');
  assert.equal(manifest.stage, 'result_produced');
  assert.deepEqual(manifest.decisionScope.evaluated, ['agy-1']);
  assert.equal(manifest.decisionScope.projections['agy-1'].selected, 'drop_call');
  assert.equal(manifest.decisionScope.projections['agy-1'].applied, 'truncate_result');
  assert.ok(manifest.wire.outputBytes < manifest.wire.inputBytes);
  assert.notEqual(manifest.wire.outputHash, manifest.wire.inputHash);
  assert.equal(manifest.batches.length, 1);
  assert.equal(manifest.attempts.length, 1);

  const analysis = await analyzeAudit(h.env);
  assert.equal(analysis.cases.length, 1);
  const auditCase = analysis.cases[0];
  assert.equal(auditCase.proposedAction, 'drop_call');
  assert.equal(auditCase.action, 'truncate_result');
  assert.equal(auditCase.ruleConforms, true);
  assert.equal(auditCase.application, 'proxy_outbound_confirmed');
  assert.ok(auditCase.tags.includes('host_projection'));
  assert.ok(!auditCase.tags.includes('policy_mismatch'));
  assert.equal(auditCase.observation.matches.length, 0);

  const report = auditReport(analysis);
  assert.equal(report.application.proxy_outbound_confirmed, 1);
  assert.deepEqual(report.policy.mismatches, []);
  const simulation = await simulateAudit(h.env, analysis, 0.5, 0.5);
  assert.equal(simulation.results[0].changes.length, 0);
  assert.equal(simulation.results[0].accepted, true);
});

test('rejected Antigravity truncate decisions keep their original policy evidence', async (t) => {
  const h = await harness(
    t,
    'evidence',
    200,
    false,
    '0.95',
    (key) => key.startsWith('drop_') ? 0.9 : 0.1,
  );
  const raw = JSON.stringify(generationPayload());
  assert.match(await postGeneration(h.proxy.url, h.ca, raw), /upstream-ok/);
  assert.equal(h.jevCalls(), 1);
  assert.equal(h.forwarded[0], raw);

  const { manifests } = await auditManifests(h.env);
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].stage, 'rejected');
  assert.equal(manifests[0].reason, 'below_minimum');
  assert.equal(manifests[0].decisionScope.projections['agy-1'].selected, 'truncate_result');
  assert.equal(manifests[0].decisionScope.projections['agy-1'].applied, 'keep');
  assert.ok(manifests[0].decisionScope.projections['agy-1'].selectedSavedChars > 0);

  const analysis = await analyzeAudit(h.env);
  assert.equal(analysis.cases.length, 1);
  assert.equal(analysis.cases[0].proposedAction, 'truncate_result');
  assert.equal(analysis.cases[0].action, 'not_applied');
  assert.equal(analysis.cases[0].ruleConforms, true);
  assert.ok(!analysis.cases[0].tags.includes('policy_mismatch'));
});

test('cached Antigravity decisions do not create another evaluation or false reappearance', async (t) => {
  const h = await harness(t);
  const raw = JSON.stringify(generationPayload());
  await postGeneration(h.proxy.url, h.ca, raw);
  await postGeneration(h.proxy.url, h.ca, raw);
  assert.equal(h.jevCalls(), 1);
  assert.equal((await auditManifests(h.env)).manifests.length, 1);
  const analysis = await analyzeAudit(h.env);
  assert.equal(analysis.cases.length, 1);
  assert.equal(analysis.cases[0].observation.matches.length, 0);
  assert.equal(auditReport(analysis).decisionReuse.agy, 1);

  const sourceDir = join(auditRoot(h.env), 'agy-sources');
  const files = await readdir(sourceDir);
  assert.equal(files.length, 1);
  const rows = (await readFile(join(sourceDir, files[0]), 'utf8')).trim().split(/\r?\n/);
  assert.equal(rows.length, 4, 'the repeated inbound history must not be journaled twice');
});

test('Antigravity metadata audit journal stores hashes but not conversation text', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jev-agy-audit-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { JEVCOMP_DATA_DIR: root };
  await configureAudit(env, 'agy', 'metadata');
  const state = createAgyAuditJournalState();
  await appendAgyOutbound(env, state, 'metadata-session', [{
    role: 'assistant',
    text: 'UNIQUE_PRIVATE_MODEL_TEXT_7c9f',
    toolCalls: [{ id: 'c1', name: 'shell', input: { command: 'PRIVATE_COMMAND_8af2' } }],
    toolResults: [{ callId: 'c1', output: 'PRIVATE_RESULT_43d1' }],
  }], 'audit-metadata');

  const files = await readdir(join(auditRoot(env), 'agy-sources'));
  const stored = await readFile(join(auditRoot(env), 'agy-sources', files[0]), 'utf8');
  assert.doesNotMatch(stored, /UNIQUE_PRIVATE_MODEL_TEXT_7c9f/);
  assert.doesNotMatch(stored, /PRIVATE_COMMAND_8af2/);
  assert.doesNotMatch(stored, /PRIVATE_RESULT_43d1/);
  const row = JSON.parse(stored);
  assert.equal(row.type, 'agy_outbound');
  assert.equal(row.message, undefined);
  assert.equal(typeof row.textHashes[0], 'string');
  assert.equal(typeof row.calls[0].inputHash, 'string');
  assert.equal(typeof row.results[0].outputHash, 'string');
});

test('Antigravity audit keeps provider failures separate from Jev decision cases', async (t) => {
  const h = await harness(t, 'evidence', 500);
  const raw = JSON.stringify(generationPayload());
  assert.match(await postGeneration(h.proxy.url, h.ca, raw), /upstream-ok/);
  assert.equal(h.jevCalls(), 1);
  assert.equal(h.forwarded[0], raw);

  const { manifests } = await auditManifests(h.env);
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].stage, 'failed');
  assert.equal(manifests[0].reason, 'provider_failed');
  assert.equal(manifests[0].attempts[0].status, 500);
  assert.equal(manifests[0].batches.length, 1);
  assert.equal(manifests[0].batches[0].responseHash, undefined);

  const analysis = await analyzeAudit(h.env);
  assert.equal(analysis.cases.length, 0);
  assert.equal(auditReport(analysis).counts.decisions, 0);
});

test('Antigravity transport failure is not journaled as model-visible context', async (t) => {
  const h = await harness(t, 'evidence', 200, true);
  const raw = JSON.stringify(generationPayload());
  assert.match(await postGeneration(h.proxy.url, h.ca, raw), /502/);

  const { manifests } = await auditManifests(h.env);
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].stage, 'result_produced');

  const analysis = await analyzeAudit(h.env);
  assert.equal(analysis.cases.length, 1);
  assert.equal(analysis.cases[0].application, 'unconfirmed');
  assert.equal(analysis.sources.get(manifests[0].id), undefined);
  assert.deepEqual(await readdir(join(auditRoot(h.env), 'agy-sources')).catch(() => []), []);
});

test('Antigravity audit journal continues across generation requests without tool pairs', async (t) => {
  const h = await harness(t);
  await postGeneration(h.proxy.url, h.ca, JSON.stringify(generationPayload()));

  const continuation = {
    model: 'gemini-audit',
    request: {
      sessionId: 'agy-audit-session',
      contents: [
        { role: 'user', parts: [{ text: 'What should I do next?' }] },
        { role: 'model', parts: [{ text: 'Inspect the final error and rerun the focused test.' }] },
      ],
    },
  };
  await postGeneration(h.proxy.url, h.ca, JSON.stringify(continuation));
  assert.equal(h.jevCalls(), 1);
  assert.equal((await auditManifests(h.env)).manifests.length, 1);

  const analysis = await analyzeAudit(h.env);
  assert.equal(analysis.cases[0].observation.eventsObserved, 1);
  assert.equal(analysis.cases[0].observation.matches.length, 0);
});

test('audit prune removes expired Antigravity-owned continuation journals', async (t) => {
  const h = await harness(t);
  await postGeneration(h.proxy.url, h.ca, JSON.stringify(generationPayload()));
  const { manifests } = await auditManifests(h.env);
  const manifestPath = join(auditRoot(h.env), 'evaluations', `${manifests[0].id}.json`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.endedAt = '2020-01-01T00:00:00.000Z';
  await writeFile(manifestPath, JSON.stringify(manifest));

  const originalLog = console.log;
  console.log = () => {};
  try {
    await auditCommand(['prune'], h.env);
  } finally {
    console.log = originalLog;
  }

  assert.deepEqual(await readdir(join(auditRoot(h.env), 'agy-sources')).catch(() => []), []);
  assert.equal((await auditManifests(h.env)).manifests.length, 0);
});

test('audit prune removes expired orphan Antigravity journals without manifests', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jev-agy-audit-orphan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { JEVCOMP_DATA_DIR: root };
  await configureAudit(env, 'agy', 'metadata');
  const state = createAgyAuditJournalState();

  const oldSession = 'orphan-old-session';
  const recentSession = 'orphan-recent-session';
  const message = {
    role: 'assistant',
    text: 'journal-only outbound',
    toolCalls: [],
  };
  await appendAgyOutbound(env, state, oldSession, [message]);
  await appendAgyOutbound(env, state, recentSession, [{ ...message, text: 'recent journal-only outbound' }]);

  assert.equal((await auditManifests(env)).manifests.length, 0);
  const audit = auditRoot(env);
  const oldJournal = join(audit, 'agy-sources', `${digest(oldSession)}.jsonl`);
  const recentJournal = join(audit, 'agy-sources', `${digest(recentSession)}.jsonl`);
  const oldBinding = join(audit, 'sources', `${digest(`agy:${oldSession}:`)}.json`);
  const recentBinding = join(audit, 'sources', `${digest(`agy:${recentSession}:`)}.json`);
  await Promise.all([readFile(oldJournal), readFile(recentJournal), readFile(oldBinding), readFile(recentBinding)]);

  const old = new Date('2020-01-01T00:00:00.000Z');
  await utimes(oldJournal, old, old);

  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));
  try {
    await auditCommand(['prune'], env);
  } finally {
    console.log = originalLog;
  }

  const result = JSON.parse(lines.at(-1));
  assert.equal(result.removedAgyJournals, 1);
  assert.equal(result.removedAgyBindings, 1);
  await assert.rejects(readFile(oldJournal), { code: 'ENOENT' });
  await assert.rejects(readFile(oldBinding), { code: 'ENOENT' });
  await readFile(recentJournal);
  await readFile(recentBinding);
});
