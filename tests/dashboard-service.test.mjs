import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDashboard, restartDashboard, runningDashboard } from '../dist/dashboard-service.js';
import { handleHook } from '../dist/hooks.js';
import { VERSION } from '../dist/version.js';

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('Claude plugin session start opens one shared dashboard and later prompts reuse it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jev-dashboard-service-'));
  const port = await freePort();
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: join(root, 'plugin'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1',
    JEVCOMP_DATA_DIR: join(root, 'data'),
    CODEX_HOME: join(root, 'codex-home'),
    JEVCOMP_CONFIG_DIR: join(root, 'config'),
    OPENROUTER_API_KEY: 'test-key',
    JEVCOMP_PROVIDER: 'openrouter',
    JEVCOMP_DASHBOARD_PORT: String(port),
  };
  t.after(async () => {
    const running = await runningDashboard(port, env);
    if (running) process.kill(running.pid);
  });

  const started = await handleHook({ session_id: 'dashboard', hook_event_name: 'SessionStart', source: 'startup' }, env, { startDashboard: true });
  assert.equal(started.systemMessage, `jevcomp dashboard: http://127.0.0.1:${port}/`);
  const first = await runningDashboard(port, env);
  assert.ok(first);

  const prompt = await handleHook({ session_id: 'dashboard', hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, env, { startDashboard: true });
  assert.equal(prompt.systemMessage, undefined);
  assert.equal(await ensureDashboard(port, env), first.url);
  assert.equal((await runningDashboard(port, env)).pid, first.pid);
});

test('a dashboard left by another installed version is replaced', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jev-dashboard-version-'));
  const port = await freePort();
  const env = { ...process.env, JEVCOMP_DATA_DIR: join(root, 'data') };
  const olderCli = join(root, 'older', 'dist', 'cli.js');
  await cp(fileURLToPath(new URL('../dist', import.meta.url)), dirname(olderCli), { recursive: true });
  await writeFile(join(root, 'older', 'package.json'), '{"type":"module"}');
  await writeFile(join(dirname(olderCli), 'version.js'), "export const VERSION = '0.0.1';");
  t.after(async () => {
    const running = await runningDashboard(port, env);
    if (running) process.kill(running.pid);
  });
  await restartDashboard(port, env, olderCli);
  const older = await runningDashboard(port, env);
  await ensureDashboard(port, env);
  const current = await runningDashboard(port, env);
  assert.notEqual(current.pid, older.pid);
  assert.equal(current.entry.toLowerCase(), fileURLToPath(new URL('../dist/cli.js', import.meta.url)).toLowerCase());
});

test('an older dashboard is replaced even when the CLI path is unchanged', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jev-dashboard-same-path-upgrade-'));
  const port = await freePort();
  const env = { ...process.env, JEVCOMP_DATA_DIR: join(root, 'data') };
  const sameCli = join(root, 'same', 'dist', 'cli.js');
  await cp(fileURLToPath(new URL('../dist', import.meta.url)), dirname(sameCli), { recursive: true });
  await writeFile(join(root, 'same', 'package.json'), '{"type":"module"}');
  await writeFile(join(dirname(sameCli), 'version.js'), "export const VERSION = '0.0.1';");
  t.after(async () => {
    const running = await runningDashboard(port, env);
    if (running) process.kill(running.pid);
  });

  await restartDashboard(port, env, sameCli);
  const older = await runningDashboard(port, env);
  assert.equal(older.version, '0.0.1');

  await writeFile(join(dirname(sameCli), 'version.js'), `export const VERSION = '${VERSION}';`);
  await ensureDashboard(port, env, sameCli);
  const current = await runningDashboard(port, env);
  assert.notEqual(current.pid, older.pid);
  assert.equal(current.version, VERSION);
});

test('the same version installed for another agent reuses the running dashboard', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jev-dashboard-shared-'));
  const port = await freePort();
  const env = { ...process.env, JEVCOMP_DATA_DIR: join(root, 'data') };
  const otherCli = join(root, 'claude', 'dist', 'cli.js');
  await cp(fileURLToPath(new URL('../dist', import.meta.url)), dirname(otherCli), { recursive: true });
  await writeFile(join(root, 'claude', 'package.json'), '{"type":"module"}');
  t.after(async () => {
    const running = await runningDashboard(port, env);
    if (running) process.kill(running.pid);
  });
  await restartDashboard(port, env, otherCli);
  const first = await runningDashboard(port, env);
  await ensureDashboard(port, env);
  assert.equal((await runningDashboard(port, env)).pid, first.pid);
});
