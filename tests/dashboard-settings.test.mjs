import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDashboard } from '../dist/dashboard.js';
import { userSettings } from '../dist/settings.js';
import { appendHistory } from '../dist/store.js';
import { VERSION } from '../dist/version.js';
import { auditConfig } from '../dist/audit-store.js';

async function dashboard(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jevcomp-dash-settings-'));
  const env = { JEVCOMP_DATA_DIR: join(root, 'data'), JEVCOMP_CONFIG_DIR: join(root, 'config'), JEVCOMP_AGY_HOME: join(root, 'agy-ca'), CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), ...extra };
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
  const response = await post({ action: 'setting', name: 'pin-recent-messages', value: '8' });
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.settings.find((item) => item.name === 'pin-recent-messages').value, '8');
  assert.equal(userSettings(env, 'codex').pinRecentMessages, 8);
  assert.equal(snapshot.version, VERSION);
  assert.deepEqual(snapshot.agents, { codex: null, claude: null, agy: { installed: false } });
  assert.deepEqual(snapshot.audit, { supported: true, enabled: false, mode: 'evidence' });
  assert.match(html, /Auditoria das decisões/);
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

test('settings API isolates agent sections and rejects an invalid agent', async (t) => {
  const { env, url, token } = await dashboard(t);
  const send = (agent, body) => fetch(`${url}api/settings?agent=${agent}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-jevcomp-token': token }, body: JSON.stringify(body),
  });
  const claude = await send('claude', { action: 'setting', name: 'pin-recent-messages', value: '8' });
  assert.equal(claude.status, 200);
  assert.equal((await claude.json()).settings.find((item) => item.name === 'pin-recent-messages').value, '8');
  assert.equal(userSettings(env, 'codex').pinRecentMessages, 6);
  assert.equal(userSettings(env, 'claude').pinRecentMessages, 8);
  const invalid = await fetch(`${url}api/settings?agent=invalid`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-jevcomp-token': token }, body: JSON.stringify({ action: 'reset' }),
  });
  assert.equal(invalid.status, 400);
});

test('dashboard toggles audit per agent and preserves its selected mode while disabled', async (t) => {
  const { env, url, token } = await dashboard(t);
  const send = (agent, body) => fetch(`${url}api/settings?agent=${agent}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-jevcomp-token': token }, body: JSON.stringify(body),
  });
  let response = await send('codex', { action: 'audit', enabled: true, mode: 'evidence' });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).audit, { supported: true, enabled: true, mode: 'evidence' });
  response = await send('claude', { action: 'audit', enabled: true, mode: 'metadata' });
  assert.deepEqual((await response.json()).audit, { supported: true, enabled: true, mode: 'metadata' });
  response = await send('claude', { action: 'audit', enabled: false, mode: 'metadata' });
  assert.deepEqual((await response.json()).audit, { supported: true, enabled: false, mode: 'metadata' });
  const config = await auditConfig(env);
  assert.equal(config.agents.codex, 'evidence');
  assert.equal(config.agents.claude, undefined);
  assert.equal(config.modes.claude, 'metadata');
  response = await send('agy', { action: 'audit', enabled: true, mode: 'evidence' });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).audit, { supported: true, enabled: true, mode: 'evidence' });
  assert.equal((await auditConfig(env)).agents.agy, 'evidence');
  assert.equal((await send('codex', { action: 'audit', enabled: 'yes', mode: 'evidence' })).status, 400);
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

test('Codex snapshot uses the install marker and latest Codex history row', async (t) => {
  const { env, post, html } = await dashboard(t);
  await appendHistory({ at: '2026-09-26T10:00:00.000Z', sessionId: 'claude', host: 'claude', status: 'restored' }, env);
  await appendHistory({ at: '2026-09-26T10:01:00.000Z', sessionId: 'codex-old', host: 'codex', status: 'restored' }, env);
  await appendHistory({ at: '2026-09-26T10:02:00.000Z', sessionId: 'codex-new', host: 'codex', status: 'restored' }, env);
  await appendHistory({ at: '2026-09-26T10:03:00.000Z', sessionId: 'legacy-codex', status: 'restored' }, env);
  const absent = await (await post({ action: 'reset' })).json();
  assert.equal(absent.agents.codex, null);
  await mkdir(env.JEVCOMP_CONFIG_DIR, { recursive: true });
  await writeFile(join(env.JEVCOMP_CONFIG_DIR, 'codex-installed'), '');
  const installed = await (await post({ action: 'reset' })).json();
  assert.deepEqual(installed.agents.codex, { lastRun: '2026-09-26T10:03:00.000Z' });
  assert.match(html, /Uso/);
});

test('the version shown matches the package manifest', async () => {
  const root = new URL('..', import.meta.url);
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  assert.equal(VERSION, pkg.version);
});
