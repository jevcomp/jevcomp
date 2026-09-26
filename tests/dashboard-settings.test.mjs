import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDashboard } from '../dist/dashboard.js';
import { userSettings } from '../dist/settings.js';
import { readHookActivity, recordHookActivity } from '../dist/store.js';
import { VERSION } from '../dist/version.js';

async function dashboard(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jevcomp-dash-settings-'));
  const env = { JEVCOMP_DATA_DIR: join(root, 'data'), JEVCOMP_CONFIG_DIR: join(root, 'config'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), ...extra };
  const { server, url } = await startDashboard(0, env);
  t.after(() => server.close());
  const html = await fetch(url).then((response) => response.text());
  const token = html.match(/name="jevcomp-token" content="([^"]+)"/)[1];
  const post = (body, headers = {}) => fetch(`${url}api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jevcomp-token': token, ...headers },
    body: JSON.stringify(body),
  });
  return { env, url, html, token, post };
}

test('settings page changes a setting and reports it back', async (t) => {
  const { env, html, post } = await dashboard(t);
  assert.match(html, /Configurações/);
  assert.match(html, /id="agents-info"/);
  const response = await post({ action: 'setting', name: 'restore-mode', value: 'minimal' });
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.settings.find((item) => item.name === 'restore-mode').value, 'minimal');
  assert.equal(userSettings(env).restoreMode, 'minimal');
  assert.equal(snapshot.version, VERSION);
  assert.deepEqual(snapshot.agents, { codex: null, claude: null, agy: { installed: false } });
});

test('a Claude Code install is reported without Codex', async (t) => {
  const claudeDir = join(await mkdtemp(join(tmpdir(), 'jevcomp-claude-')), '.claude');
  await mkdir(join(claudeDir, 'plugins'), { recursive: true });
  await writeFile(join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'jevcomp@jevcomp': [{ version: VERSION }] } }));
  await writeFile(join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'jevcomp@jevcomp': true }, env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } }));
  const { post } = await dashboard(t, { CLAUDE_CONFIG_DIR: claudeDir });
  const snapshot = await (await post({ action: 'reset' })).json();
  assert.equal(snapshot.agents.codex, null);
  assert.deepEqual(snapshot.agents.claude, { functionHooks: true, lastRun: null });
});

test('a key saved from the page is shown only by its last four characters', async (t) => {
  const { env, post } = await dashboard(t, { OPENROUTER_API_KEY: '', TYPESAFE_API_KEY: '' });
  const switched = await post({ action: 'provider', provider: 'typesafe' });
  assert.equal(switched.status, 400);
  const saved = await post({ action: 'key', provider: 'typesafe', key: 'ts-secret-value-9f3a' });
  const snapshot = await saved.json();
  assert.equal(snapshot.provider, 'typesafe');
  assert.deepEqual(snapshot.keys.typesafe, { source: 'saved', ending: '9f3a' });
  assert.doesNotMatch(JSON.stringify(snapshot), /ts-secret-value/);
  assert.equal((await readFile(join(env.JEVCOMP_CONFIG_DIR, 'typesafe_api_key'), 'utf8')).trim(), 'ts-secret-value-9f3a');
});

test('changes without the page token or from another origin are refused', async (t) => {
  const { url, post } = await dashboard(t);
  assert.equal((await post({ action: 'reset' }, { 'x-jevcomp-token': 'guess' })).status, 403);
  assert.equal((await post({ action: 'reset' }, { origin: 'https://example.com' })).status, 403);
});

test('requests addressed to another host name are refused', async (t) => {
  const { url } = await dashboard(t);
  const { port } = new URL(url);
  const status = await new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path: '/api/settings', headers: { host: `attacker.example:${port}` } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject).end();
  });
  assert.equal(status, 403);
});

test('hook runs are remembered as proof the hooks are active', async () => {
  const env = { JEVCOMP_DATA_DIR: await mkdtemp(join(tmpdir(), 'jevcomp-hook-activity-')) };
  await recordHookActivity('UserPromptSubmit', env);
  await recordHookActivity('SomethingElse', env);
  const activity = await readHookActivity(env);
  assert.deepEqual(Object.keys(activity), ['UserPromptSubmit']);
});

test('the version shown matches the package manifest', async () => {
  const root = new URL('..', import.meta.url);
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(VERSION, pkg.version);
});
