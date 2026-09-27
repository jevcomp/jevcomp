import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compact } from '../dist/compact.js';
import { beginAudit, bindAuditSource, auditManifests } from '../dist/audit.js';
import { analyzeAudit, auditReport, expectedAction, inspectAuditCase, simulateAudit } from '../dist/audit-analysis.js';
import { auditConfig, auditRoot, configureAudit, atomicJson } from '../dist/audit-store.js';
import { appendHistory } from '../dist/store.js';
import { auditCommand } from '../dist/audit-cli.js';
import { compactForClaude } from '../dist/claude-compact.js';
import { createServer } from 'node:http';

const transcript = () => [
  { role: 'user', text: 'Read the source', toolCalls: [] },
  { role: 'assistant', text: '', toolCalls: [{ id: 'call-one', name: 'Read', input: { path: 'src/a.ts' } }] },
  { role: 'user', text: '', toolCalls: [], toolResults: [{ callId: 'call-one', output: 'source content '.repeat(200) }] },
  { role: 'assistant', text: 'I found the answer', toolCalls: [] },
];

test('invalid scores remain unauditable instead of appearing policy compliant', () => {
  const manifest = { settings: { lossThreshold: 0.5, truncateHeadChars: 300 } };
  const decision = { pinned: false, dropLoss: Number.NaN, truncateLoss: 0.1, resultChars: 1000 };
  assert.equal(expectedAction(decision, manifest), undefined);
});

async function setup(mode = 'evidence') {
  const root = await mkdtemp(join(tmpdir(), 'jev-audit-'));
  const env = { JEVCOMP_DATA_DIR: root };
  await configureAudit(env, 'claude', mode);
  return env;
}

async function evaluate(env, id, asker, sourcePath) {
  const messages = transcript();
  const capture = await beginAudit(env, 'claude', id, messages, { minReductionRatio: 0, provider: 'typesafe' }, 'session-one');
  assert.ok(capture);
  const result = await compact(messages, asker, { preserveRecentMessages: 0, lossThreshold: 0.5, auditObserver: capture.observe });
  await appendHistory({ at: new Date().toISOString(), runId: id, auditId: id, sessionId: 'session-one', host: 'claude', phase: 'precompact', status: 'prepared', decisions: result.decisions, stats: result.stats }, env);
  await capture.finish('result_produced', 'cut_returned_to_hook', true, result.messages);
  return result;
}

test('audit stores evidence once, checks the policy, finds later identical output and simulates locally', async () => {
  const env = await setup();
  const source = join(env.JEVCOMP_DATA_DIR, 'session-one.jsonl');
  await writeFile(source, '');
  await bindAuditSource(env, 'claude', 'session-one', source);
  const asker = { ask: async (_state, questions) => ({ answers: Object.fromEntries(Object.keys(questions).map(key => [key, { noul: 0.1 }])) }) };
  const first = await evaluate(env, 'audit-one', asker);
  assert.equal(first.decisions[0].action, 'drop_call');
  const firstObjects = (await readdir(join(auditRoot(env), 'objects'))).length;
  await evaluate(env, 'audit-two', asker);
  const secondObjects = (await readdir(join(auditRoot(env), 'objects'))).length;
  assert.ok(secondObjects <= firstObjects + 6, `evidence should share transcript nodes (${firstObjects}, ${secondObjects})`);
  await appendFile(source, JSON.stringify({ type: 'system', sessionId: 'session-one', timestamp: new Date(Date.now() + 500).toISOString(), padding: 'x'.repeat(5000) }) + '\n');
  await appendFile(source, JSON.stringify({ type: 'system', subtype: 'compact_boundary', sessionId: 'session-one', timestamp: new Date(Date.now() + 1000).toISOString() }) + '\n');
  await appendFile(source, JSON.stringify({ type: 'user', sessionId: 'session-one', timestamp: new Date(Date.now() + 2000).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'new-call', content: 'source content '.repeat(200) }] } }) + '\n');
  const analysis = await analyzeAudit(env);
  assert.equal(analysis.cases.length, 2);
  assert.equal(analysis.cases[0].ruleConforms, true);
  assert.equal(analysis.cases[0].observation.matches.length, 1);
  const report = auditReport(analysis);
  assert.equal(report.counts.firstEvaluations.drop_call, 1);
  assert.equal(report.counts.decisions, 2);
  const inspected = await inspectAuditCase(env, analysis, analysis.cases[0].id);
  assert.equal(inspected.before.length, 2);
  assert.ok(inspected.evidenceAvailable);
  const original = await simulateAudit(env, analysis, 0.5, 0.5, 0);
  assert.equal(original.results[0].changes.length, 0);
  const conservative = await simulateAudit(env, analysis, 0, 0, 0);
  assert.equal(conservative.results[0].changes[0].to, 'keep');
  const sourceText = await readFile(source, 'utf8');
  await writeFile(source, sourceText.replace('source content '.repeat(200), 'revised content'.padEnd('source content '.repeat(200).length, ' ')));
  assert.equal((await analyzeAudit(env)).cases[0].observation.matches.length, 0);
});

test('metadata capture records no conversation objects and quota failure leaves compaction intact', async () => {
  const env = await setup('metadata');
  const asker = { ask: async (_state, questions) => ({ answers: Object.fromEntries(Object.keys(questions).map(key => [key, { noul: 0.1 }])) }) };
  await evaluate(env, 'metadata-one', asker);
  assert.deepEqual(await readdir(join(auditRoot(env), 'objects')).catch(() => []), []);
  const manifests = await auditManifests(env);
  assert.equal(manifests.manifests[0].stage, 'result_produced');
  assert.deepEqual(manifests.manifests[0].references, {});
  const config = await auditConfig(env);
  config.maxBytes = 1;
  await atomicJson(join(auditRoot(env), 'config.json'), config);
  const capture = await beginAudit(env, 'claude', 'cannot-store', transcript(), {}, 'session-one');
  assert.equal(capture, undefined);
  const result = await compact(transcript(), asker, { preserveRecentMessages: 0 });
  assert.equal(result.decisions[0].action, 'drop_call');
  assert.ok(JSON.parse(await readFile(join(auditRoot(env), 'last-failure.json'), 'utf8')).reason);
});

test('audit CLI reports, exports, records a human verdict and prunes only expired evidence', async () => {
  const env = await setup();
  const asker = { ask: async (_state, questions) => ({ answers: Object.fromEntries(Object.keys(questions).map(key => [key, { noul: 0.1 }])) }) };
  await evaluate(env, 'cli-one', asker);
  const original = console.log;
  const lines = [];
  console.log = value => lines.push(String(value));
  try {
    await auditCommand(['status'], env);
    assert.equal(JSON.parse(lines.at(-1)).evaluations, 1);
    await auditCommand(['report'], env);
    const report = JSON.parse(lines.at(-1));
    assert.equal(report.policy.mismatches.length, 0);
    const id = report.sample.selected[0].id;
    await auditCommand(['inspect', id, '--max-chars', '200000'], env);
    assert.equal(JSON.parse(lines.at(-1)).case.id, id);
    await auditCommand(['review', id, '--verdict', 'inconclusive', '--reason', 'No continuation yet'], env);
    assert.equal(JSON.parse(lines.at(-1)).verdict, 'inconclusive');
    await auditCommand(['simulate', '--drop', '0', '--truncate', '0'], env);
    assert.equal(JSON.parse(lines.at(-1)).results[0].changes[0].to, 'keep');
    await auditCommand(['export', '--ids', id, '--max-chars', '200000'], env);
    assert.equal(JSON.parse(lines.at(-1)).cases.length, 1);
    assert.equal(JSON.parse(lines.at(-1)).simulations.length, 3);
    await auditCommand(['prune'], env);
    assert.equal(JSON.parse(lines.at(-1)).keptEvaluations, 1);
  } finally { console.log = original; }
});

test('audit leaves Jev request bodies and decisions identical, including a rejected cut', async (t) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const part of request) body += part;
    requests.push(body);
    const questions = JSON.parse(body).questions;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ answers: Object.fromEntries(Object.keys(questions).map(key => [key, { noul: 0.1 }])) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { JEVCOMP_DATA_DIR: await mkdtemp(join(tmpdir(), 'jev-audit-neutral-')), JEVCOMP_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'test', JEV_BASE_URL: `http://127.0.0.1:${server.address().port}`, JEVCOMP_PIN_RECENT_MESSAGES: '0', JEVCOMP_MIN_REDUCTION_RATIO: '0.99', JEVCOMP_RETRIES: '0' };
  const input = { sessionId: 'session-neutral', messages: transcript() };
  const off = await compactForClaude(input, env);
  await configureAudit(env, 'claude', 'evidence');
  const on = await compactForClaude(input, env);
  assert.deepEqual(on, off);
  assert.equal(requests.length, 2);
  assert.equal(requests[0], requests[1]);
  const { manifests } = await auditManifests(env);
  assert.equal(manifests.length, 1);
  assert.equal(manifests[0].stage, 'rejected');
  assert.equal(manifests[0].reason, 'below_minimum');
  assert.equal(manifests[0].batches.length, 1);
});

test('audit recognizes omitted content and explicit use of kept text without treating them as proof of harm', async () => {
  const env = await setup();
  const source = join(env.JEVCOMP_DATA_DIR, 'session-one.jsonl');
  await writeFile(source, '');
  await bindAuditSource(env, 'claude', 'session-one', source);
  const shortened = { ask: async (_state, questions) => ({ answers: Object.fromEntries(Object.keys(questions).map(key => [key, { noul: key.startsWith('drop_') ? 0.9 : 0.1 }])) }) };
  await evaluate(env, 'short-one', shortened);
  await appendFile(source, JSON.stringify({ type: 'system', subtype: 'compact_boundary', sessionId: 'session-one', timestamp: new Date(Date.now() + 1000).toISOString() }) + '\n');
  await appendFile(source, JSON.stringify({ type: 'user', sessionId: 'session-one', timestamp: new Date(Date.now() + 2000).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'repeat', content: 'source content '.repeat(80) }] } }) + '\n');
  const analysis = await analyzeAudit(env);
  assert.equal(analysis.cases[0].action, 'truncate_result');
  assert.ok(analysis.cases[0].observation.matches.some(match => match.kind === 'omitted_excerpt_reappeared'));
  assert.equal(analysis.cases[0].application, 'unconfirmed');
});

test('prune removes an expired complete session and its unreferenced content', async () => {
  const env = await setup();
  const asker = { ask: async (_state, questions) => ({ answers: Object.fromEntries(Object.keys(questions).map(key => [key, { noul: 0.1 }])) }) };
  await evaluate(env, 'old-evaluation', asker);
  const path = join(auditRoot(env), 'evaluations', 'old-evaluation.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.endedAt = '2020-01-01T00:00:00.000Z';
  await atomicJson(path, manifest);
  const printed = [];
  const original = console.log;
  console.log = value => printed.push(String(value));
  try { await auditCommand(['prune'], env); } finally { console.log = original; }
  assert.equal(JSON.parse(printed[0]).expiredEvaluations, 1);
  assert.equal((await auditManifests(env)).manifests.length, 0);
  assert.equal((await readdir(join(auditRoot(env), 'objects'))).length, 0);
});
