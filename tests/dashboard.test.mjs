import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendHistory } from '../dist/store.js';
import { stats, startDashboard } from '../dist/dashboard.js';

const compactStats = {
  messagesBefore: 8, messagesAfter: 5, charsBefore: 10000, charsAfter: 4000,
  calls: 3, kept: 1, resultsTruncated: 1, callsDropped: 1, pinned: 0,
  stateTokens: 900, stateStage: 'full', requests: 2, jevInputTokens: 1200, jevOutputTokens: 40, ms: 250,
};

const decisions = [
  { id: 't1', callId: 'c1', name: 'grep', inputPreview: 'q=x', dropLoss: 0.1, truncateLoss: 0.1, action: 'drop_call', resultChars: 4000, originalChars: 4100, savedChars: 4100, pinned: false },
  { id: 't2', callId: 'c2', name: 'read', inputPreview: 'a.ts', dropLoss: 0.9, truncateLoss: 0.1, action: 'truncate_result', resultChars: 2200, originalChars: 2250, savedChars: 1900, pinned: false },
  { id: 't3', callId: 'c3', name: 'test', inputPreview: '', dropLoss: 0.9, truncateLoss: 0.9, action: 'keep', resultChars: 1000, originalChars: 1010, savedChars: 0, pinned: false },
];

test('Codex proxy compaction displays returned text even without a legacy injection', async () => {
  const env = { JEVCOMP_DATA_DIR: await mkdtemp(join(tmpdir(), 'jev-dashboard-proxy-')) };
  const row = { at: '2026-09-26T12:00:00Z', runId: 'proxy', sessionId: 'proxy', host: 'codex', stats: compactStats, retainedChars: 3900, decisions };
  await appendHistory({ ...row, phase: 'precompact', status: 'prepared' }, env);
  await appendHistory({ ...row, phase: 'postcompact', status: 'restored', injectedPayloadChars: 0, injectedChars: 0 }, env);
  const summary = await stats(env, 'codex');
  assert.equal(summary.runs[0].status, 'restored');
  assert.equal(summary.runs[0].directCompaction, true);
  assert.equal(summary.lastCompaction.status, 'restored');
  assert.equal(summary.lastCompaction.directCompaction, true);
  assert.equal(summary.lastCompaction.returnedChars, 3900);
  assert.equal(summary.lastCompaction.charsBefore, 10000);
  assert.equal(summary.injectedPayloadChars, 0);
  assert.equal(summary.directCompactions, 1);
  assert.equal(summary.deliveredChars, 3900);
  await appendHistory({ ...row, runId: 'legacy', phase: 'restore', status: 'restored', injectedPayloadChars: 800 }, env);
  const mixed = await stats(env, 'codex');
  assert.equal(mixed.directCompactions, 1);
  assert.equal(mixed.deliveredChars, 4700);
});

test('dashboard reports measured impact without invented token-savings estimates', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jev-dashboard-'));
  const env = { JEVCOMP_DATA_DIR: root, JEVCOMP_CONFIG_DIR: join(root, 'config') };
  const runId = '2026-09-22T12:00:00.000Z';
  await appendHistory({ at: runId, runId, sessionId: 's1', phase: 'precompact', status: 'prepared', provider: 'typesafe', stats: compactStats, decisions, retainedChars: 4300 }, env);
  await appendHistory({ at: '2026-09-22T12:00:01.000Z', runId, sessionId: 's1', phase: 'restore', status: 'restored', stats: compactStats, restoreMode: 'balanced', retainedChars: 4300, injectedPayloadChars: 1800, injectedChars: 2100 }, env);
  await appendHistory({ at: '2026-09-22T12:01:00.000Z', runId: 'skip', sessionId: 's2', phase: 'precompact', status: 'skipped', stats: compactStats }, env);
  await appendHistory({ at: '2026-09-22T12:02:00.000Z', runId: 'fail', sessionId: 's3', phase: 'precompact', status: 'failed', detail: 'provider unavailable' }, env);
  await appendHistory({ at: '2026-09-22T12:02:30.000Z', runId: 'prepared-only', sessionId: 's5', phase: 'precompact', status: 'prepared', stats: compactStats, decisions, retainedChars: 4300 }, env);

  const s = await stats(env);
  assert.equal(s.transcriptCharsRemoved, 12000);
  assert.equal(s.transcriptReductionRatio, 0.6);
  assert.equal(s.completedCharsRemoved, 6000);
  assert.equal(s.completedReductionRatio, 0.6);
  assert.equal(s.injectedChars, 2100);
  assert.equal(s.injectedPayloadChars, 1800);
  assert.equal(s.directCompactions, 0);
  assert.equal(s.deliveredChars, 1800);
  // The skipped run still consumed Jev usage, so provider cost is counted twice here.
  assert.equal(s.jevInputTokens, 3600);
  assert.equal(s.jevOutputTokens, 120);
  assert.equal(s.nativeFallbacks, 1);
  assert.equal(s.skipped, 1);
  assert.equal(s.byTool[0].tool, 'grep');
  assert.equal(s.byTool[0].removedChars, 4100); // prepared-only run is not presented as realized tool reduction
  assert.equal('estimatedPrunedTokens' in s, false);
  assert.equal(s.lastCompaction.at, runId);
  assert.equal(s.lastCompaction.status, 'restored');
  assert.equal(s.lastCompaction.injectedPayloadChars, 1800);
  assert.deepEqual(s.lastCompaction.blocks.map((b) => [b.decision, b.chars, b.label]), [['r', 4100, 'q=x'], ['s', 2250, 'a.ts'], ['k', 1010, 'test']]);
  assert.deepEqual(s.runStatusCounts, { prepared: 1, restored: 1, skipped: 1, failed: 1 });
  assert.equal(s.recentDecisions[0].decision, 'k');

  const dashboard = await startDashboard(0, env);
  t.after(() => dashboard.server.close());
  const html = await fetch(dashboard.url).then((r) => r.text());
  for (const section of ['Última compactação', 'Compactações recentes', 'Decisões recentes', 'Risco se descartar', 'Conexão', 'Comportamento']) assert.match(html, new RegExp(section));
  for (const old of ['Quanto texto foi reduzido', 'Decisões de retenção', 'Duplicatas evitadas', 'De onde vem essa redução']) assert.doesNotMatch(html, new RegExp(old));
  assert.doesNotMatch(html, /observe/i);
  assert.match(html, /color-scheme:dark/);
  assert.doesNotMatch(html, /estimated tokens saved/i);
  const health = await fetch(`${dashboard.url}api/health`).then((r) => r.json());
  assert.equal(health.service, 'jevcomp-dashboard');
  assert.equal(health.pid, process.pid);
  const api = await fetch(`${dashboard.url}api/stats`).then((r) => r.json());
  assert.equal(api.transcriptCharsRemoved, 12000);
  assert.equal(api.completedCharsRemoved, 6000);

  // Dashboard caches parsed history while the file is unchanged, but an append must invalidate it.
  await appendHistory({ at: '2026-09-22T12:03:00.000Z', runId: 'fail-2', sessionId: 's4', phase: 'precompact', status: 'failed', detail: 'transcript unavailable' }, env);
  const refreshed = await fetch(`${dashboard.url}api/stats`).then((r) => r.json());
  assert.equal(refreshed.nativeFallbacks, 2);
});

test('dashboard cache invalidates when persisted settings change without new history', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { startDashboard } = await import('../dist/dashboard.js');
  const { setUserSetting } = await import('../dist/settings.js');
  const root = await mkdtemp(join(tmpdir(), 'jev-dashboard-settings-'));
  const env = { JEVCOMP_DATA_DIR: join(root, 'data'), JEVCOMP_CONFIG_DIR: join(root, 'config') };
  const { server, url } = await startDashboard(0, env);
  try {
    const before = await fetch(`${url}api/stats`).then((response) => response.json());
    await setUserSetting('pin-recent-messages', '8', env, 'codex');
    const after = await fetch(`${url}api/stats`).then((response) => response.json());
    assert.equal(after.settings.pinRecentMessages, 8);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('runs with nothing to send or a too-short conversation get their own status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-dashboard-status-'));
  const env = { JEVCOMP_DATA_DIR: root };
  const runId = '2026-09-25T10:00:00.000Z';
  await appendHistory({ at: runId, runId, sessionId: 'n1', phase: 'precompact', status: 'prepared', stats: compactStats, decisions }, env);
  await appendHistory({ at: '2026-09-25T10:00:05.000Z', runId, sessionId: 'n1', phase: 'restore', status: 'restored', stats: compactStats, injectedPayloadChars: 0, injectedChars: 0 }, env);
  await appendHistory({ at: '2026-09-25T10:01:00.000Z', runId: 'short', sessionId: 'n2', phase: 'precompact', status: 'skipped', detail: 'transcript has fewer than 2 messages' }, env);
  await appendHistory({ at: '2026-09-25T10:02:00.000Z', runId: 'small', sessionId: 'n3', phase: 'precompact', status: 'skipped', stats: compactStats, detail: 'reduction below 0.15' }, env);
  const statuses = Object.fromEntries((await stats(env)).runs.map((run) => [run.sessionId, run.status]));
  assert.deepEqual(statuses, { n1: 'nothing_missing', n2: 'too_short', n3: 'skipped' });
});

test('last compaction names each block by its command, even from a cut preview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-dashboard-label-'));
  const env = { JEVCOMP_DATA_DIR: root };
  const block = (name, inputPreview) => ({ id: name, callId: name, name, inputPreview, dropLoss: 0.1, truncateLoss: 0.1, action: 'keep', resultChars: 10, originalChars: 10, savedChars: 0, pinned: false });
  await appendHistory({ at: '2026-09-22T12:00:00.000Z', runId: 'r', sessionId: 's', phase: 'precompact', status: 'prepared', stats: compactStats, decisions: [
    block('exec_command', '{"cmd":"git diff -- src \\"a b\\"","workdir":"C:\\x'),
    block('exec', 'const result = await tools.exec_command({ cmd: "npm test", yield_time_ms'),
    block('read', ''),
    block('exec_command', '{"cmd":"Get-Content src/a.ts"}'),
    block('exec_command', '{"cmd":"rg restore tests"}'),
  ] }, env);
  const s = await stats(env);
  assert.deepEqual(s.lastCompaction.blocks.map((b) => b.label), ['git diff -- src "a b"', 'npm test', 'read', 'Get-Content src/a.ts', 'rg restore tests']);
  assert.deepEqual(s.recentDecisions.map((d) => d.kind).reverse(), ['comando', 'comando', 'leitura de arquivo', 'leitura de arquivo', 'busca']);
});
