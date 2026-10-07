import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adoptLegacyEnvironment } from '../dist/legacy.js';
import { readHistory } from '../dist/store.js';
import { ensureDashboard, runningDashboard } from '../dist/dashboard-service.js';

test('old JEV_COMPACT_* settings apply unless the new name is set', () => {
  const env = { JEV_COMPACT_RETRIES: '0', JEVCOMP_RETRIES: '2' };
  adoptLegacyEnvironment(env);
  assert.equal(env.JEVCOMP_RETRIES, '2');
});

test('history recorded by the old plugin stays visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jevcomp-legacy-history-'));
  const oldData = join(root, 'plugins', 'data', 'jev-compact-jev-compact');
  await mkdir(oldData, { recursive: true });
  await writeFile(join(oldData, 'history.jsonl'), `${JSON.stringify({ at: '2026-09-24T00:00:00.000Z', sessionId: 'old', status: 'ready', runId: 'r1' })}\n`);
  const rows = await readHistory({ JEVCOMP_HISTORY_DAYS: '3650', CODEX_HOME: root, PLUGIN_DATA: join(root, 'plugins', 'data', 'jevcomp-jevcomp') });
  assert.ok(rows.some((row) => row.sessionId === 'old'));
});

test('a dashboard started under another data folder is replaced instead of blocking the port', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jevcomp-orphan-dashboard-'));
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const oldEnv = { ...process.env, JEVCOMP_DATA_DIR: join(root, 'old') };
  const newEnv = { ...process.env, JEVCOMP_DATA_DIR: join(root, 'new') };
  t.after(async () => {
    for (const env of [oldEnv, newEnv]) {
      const running = await runningDashboard(port, env);
      if (running) process.kill(running.pid);
    }
  });
  const olderCli = join(root, 'older', 'dist', 'cli.js');
  await cp(fileURLToPath(new URL('../dist', import.meta.url)), dirname(olderCli), { recursive: true });
  await writeFile(join(root, 'older', 'package.json'), '{"type":"module"}');
  await writeFile(join(dirname(olderCli), 'version.js'), "export const VERSION = '0.0.1';");
  await ensureDashboard(port, oldEnv, olderCli);
  const orphan = await runningDashboard(port, oldEnv);
  await ensureDashboard(port, newEnv);
  const current = await runningDashboard(port, newEnv);
  assert.ok(current);
  assert.notEqual(current.pid, orphan.pid);
});
