import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyJevCut, claudeMessageChars, toJevMessages } from '../dist/claude.js';
import { compactForClaude } from '../dist/claude-compact.js';
import { stats } from '../dist/dashboard.js';
import { handleHook } from '../dist/hooks.js';
import { setUserSetting } from '../dist/settings.js';
import { configureAudit, auditRoot, digest } from '../dist/audit-store.js';
import { auditManifests } from '../dist/audit.js';
import { register as registerPlugin } from '../hooks/claude.js';

const use = (id, text) => ({ tool_use_id: id, tool: 'Read', input: { file_path: id }, text });
const result = (id, text) => ({ tool_use_id: id, text, isError: false });
const transcript = () => [
  { role: 'user', text: 'Fix the login bug.', toolUses: [], handle: 'h0' },
  { role: 'assistant', text: '', toolUses: [use('a', 'x'.repeat(4000)), use('b', 'y'.repeat(4000))], handle: 'h1' },
  { role: 'user', text: '', toolUses: [], toolResults: [result('a', 'x'.repeat(4000)), result('b', 'y'.repeat(4000))], handle: 'h2' },
  { role: 'assistant', text: 'Found it.', toolUses: [], handle: 'h3' },
];

test('Claude function hook passes the native session identity without adding model calls', async () => {
  let callback;
  registerPlugin((event, handler) => { if (event === 'session.compact') callback = handler; }, { provider: 'typesafe', apiKey: 'test' });
  let sent;
  const context = {
    session: { id: async () => 'native-session-id' },
    process: { run: async (_args, options) => { sent = JSON.parse(options.stdin); return { exitCode: 0, stdout: JSON.stringify({ apply: false, reason: 'below minimum' }) }; } },
    ui: { log: () => {} },
  };
  const event = { trigger: 'auto', messages: transcript() };
  const native = { messages: event.messages };
  assert.equal(await callback(context, event, async () => native), native);
  assert.equal(sent.sessionId, 'native-session-id');
  assert.deepEqual(sent.hostMessages, event.messages);
  assert.equal('messages' in sent, false);
});

test('a Jev cut keeps untouched Claude messages as the engine gave them and rebuilds edited ones', () => {
  const messages = transcript();
  messages[1].toolUses[1].result = { stdout: 'y'.repeat(4000), metadata: 'large structured copy' };
  messages[2].toolResults[1].result = { stdout: 'y'.repeat(4000), metadata: 'large structured copy' };
  const out = applyJevCut(messages, { dropped: ['a'], truncated: { b: 'yyy [omitted]' } });
  assert.equal(out[0], messages[0]);
  assert.equal(out[3], messages[3]);
  assert.equal(out[1].handle, undefined);
  assert.deepEqual(out[1].toolUses.map((u) => u.tool_use_id), ['b']);
  assert.equal(out[1].toolUses[0].text, 'yyy [omitted]');
  assert.equal('result' in out[1].toolUses[0], false);
  assert.deepEqual(out[2].toolResults, [{ tool_use_id: 'b', text: 'yyy [omitted]', isError: false }]);
  assert.deepEqual(toJevMessages(messages)[2].toolResults.map((r) => r.callId), ['a', 'b']);
});

test('Claude minimum reduction uses the actual hook payload, including structured result copies', async (t) => {
  const jev = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const answers = Object.fromEntries(Object.keys(JSON.parse(body).questions).map((key) => [
      key,
      { noul: key.startsWith('drop_') ? 0.9 : 0.1 },
    ]));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ answers }));
  });
  await new Promise((resolve) => jev.listen(0, '127.0.0.1', resolve));
  t.after(() => jev.close());

  const root = await mkdtemp(join(tmpdir(), 'jev-claude-effective-'));
  const env = {
    ...process.env,
    JEVCOMP_DATA_DIR: join(root, 'data'),
    JEVCOMP_CONFIG_DIR: join(root, 'config'),
    JEVCOMP_PROVIDER: 'typesafe',
    TYPESAFE_API_KEY: 'test',
    JEV_BASE_URL: `http://127.0.0.1:${jev.address().port}`,
    JEVCOMP_RETRIES: '0',
  };
  for (const name of ['JEVCOMP_PIN_RECENT_MESSAGES', 'JEVCOMP_PRESERVE_RECENT', 'JEVCOMP_LOSS_THRESHOLD', 'JEVCOMP_KEEP_THRESHOLD', 'JEVCOMP_MIN_REDUCTION_RATIO', 'JEVCOMP_MIN_REDUCTION', 'JEVCOMP_SETTINGS_FILE']) delete env[name];
  await setUserSetting('pin-recent-messages', '0', env, 'claude');
  await setUserSetting('loss-threshold', '0.5', env, 'claude');
  await setUserSetting('min-reduction-ratio', '0.3', env, 'claude');

  const duplicate = 'tool evidence '.repeat(350);
  const hostMessages = [
    { role: 'user', text: 'u'.repeat(20_000), toolUses: [], handle: 'h0' },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'c1', tool: 'Read', input: { file_path: 'x' }, text: duplicate, result: { stdout: duplicate } }], handle: 'h1' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c1', text: duplicate, isError: false, result: { stdout: duplicate } }], handle: 'h2' },
    { role: 'assistant', text: 'continue', toolUses: [], handle: 'h3' },
  ];
  const before = claudeMessageChars(hostMessages);
  const response = await compactForClaude({ hostMessages }, env);
  assert.equal(response.apply, true);
  const afterMessages = applyJevCut(hostMessages, response);
  const actualReduction = (before - claudeMessageChars(afterMessages)) / before;
  assert.ok(actualReduction >= 0.3);
  assert.match(response.summary, /^\d+% cut:/);

  const history = (await readFile(join(root, 'data', 'history.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(history[0].stats.charsBefore, before);
  assert.equal(history[0].stats.charsAfter, claudeMessageChars(afterMessages));
});

test('the claude-compact command runs Jev on a Claude transcript and records it as a Claude run', async (t) => {
  const jev = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const answers = Object.fromEntries(Object.keys(JSON.parse(body).questions).map((key) => [key, { noul: 0.01 }]));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ answers }));
  });
  await new Promise((resolve) => jev.listen(0, '127.0.0.1', resolve));
  t.after(() => jev.close());
  const root = await mkdtemp(join(tmpdir(), 'jev-claude-'));
  const env = {
    ...process.env, JEVCOMP_DATA_DIR: join(root, 'data'), JEVCOMP_CONFIG_DIR: join(root, 'config'), JEVCOMP_PROVIDER: 'typesafe', TYPESAFE_API_KEY: 'test',
    JEV_BASE_URL: `http://127.0.0.1:${jev.address().port}`, JEVCOMP_RETRIES: '0',
  };
  for (const name of ['JEVCOMP_PIN_RECENT_MESSAGES', 'JEVCOMP_PRESERVE_RECENT', 'JEVCOMP_LOSS_THRESHOLD', 'JEVCOMP_KEEP_THRESHOLD', 'JEVCOMP_MIN_REDUCTION_RATIO', 'JEVCOMP_MIN_REDUCTION', 'JEVCOMP_SETTINGS_FILE']) delete env[name];
  await setUserSetting('pin-recent-messages', '12', env, 'codex');
  await setUserSetting('loss-threshold', '0', env, 'codex');
  await setUserSetting('pin-recent-messages', '0', env, 'claude');
  await setUserSetting('loss-threshold', '0.5', env, 'claude');
  await setUserSetting('min-reduction-ratio', '0', env, 'claude');
  await configureAudit(env, 'claude', 'evidence');
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const child = spawn(process.execPath, [cli, 'claude-compact'], { env });
  child.stdin.end(JSON.stringify({ messages: toJevMessages(transcript()) }));
  let output = '';
  for await (const chunk of child.stdout) output += chunk;
  const cut = JSON.parse(output);
  assert.equal(cut.apply, true);
  assert.deepEqual(cut.dropped.sort(), ['a', 'b']);
  assert.deepEqual(applyJevCut(transcript(), cut).map((m) => m.text), ['Fix the login bug.', 'Found it.']);

  const s = await stats(env);
  assert.equal(s.runs[0].host, 'claude');
  assert.equal(s.runs[0].status, 'restored');
  assert.equal(s.lastCompaction.host, 'claude');
  const audited = await auditManifests(env);
  assert.equal(audited.manifests.length, 1);
  assert.equal(audited.manifests[0].stage, 'result_produced');
  assert.ok(audited.manifests[0].references.input);
  assert.equal(audited.manifests[0].sessionSource, 'unknown');
  assert.deepEqual((await stats(env, 'claude')).settings, { pinRecentMessages: 0, lossThreshold: 0.5, minReductionRatio: 0 });
  assert.equal((await stats(env, 'codex')).settings.pinRecentMessages, 12);
});

test('in Claude Code the command hook only starts the dashboard and never runs the Codex flow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-claude-hook-'));
  const env = { JEVCOMP_DATA_DIR: join(root, 'data'), CLAUDE_PLUGIN_ROOT: root, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', TYPESAFE_API_KEY: 'test', JEVCOMP_PROVIDER: 'typesafe' };
  const pre = await handleHook({ session_id: 's', hook_event_name: 'PreCompact', transcript_path: join(root, 'missing.jsonl') }, env);
  assert.deepEqual(pre, { continue: true, suppressOutput: true });
});

test('Claude startup hook binds the native transcript only when audit is enabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-claude-audit-source-'));
  const env = { JEVCOMP_DATA_DIR: join(root, 'data'), CLAUDE_PLUGIN_ROOT: root, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', TYPESAFE_API_KEY: 'test', JEVCOMP_PROVIDER: 'typesafe' };
  await configureAudit(env, 'claude', 'metadata');
  const path = join(root, 'session-one.jsonl');
  await handleHook({ session_id: 'session-one', transcript_path: path, hook_event_name: 'SessionStart', source: 'startup' }, env);
  const binding = JSON.parse(await readFile(join(auditRoot(env), 'sources', `${digest('claude:session-one:')}.json`), 'utf8'));
  assert.equal(binding.path, path);
});

test('the first Claude Code session turns function hooks on in the user settings and keeps the rest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-claude-settings-'));
  const settingsFile = join(root, 'settings.json');
  await writeFile(settingsFile, JSON.stringify({ model: 'opus', env: { OTHER: 'x' } }));
  const env = { JEVCOMP_DATA_DIR: join(root, 'data'), CLAUDE_PLUGIN_ROOT: root, CLAUDE_CONFIG_DIR: root, TYPESAFE_API_KEY: 'test', JEVCOMP_PROVIDER: 'typesafe' };
  const first = await handleHook({ session_id: 's', hook_event_name: 'SessionStart', source: 'startup' }, env);
  assert.match(first.systemMessage, /Restart Claude Code/);
  assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')), { model: 'opus', env: { OTHER: 'x', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } });

  await writeFile(settingsFile, '{ broken');
  const broken = await handleHook({ session_id: 's', hook_event_name: 'SessionStart', source: 'startup' }, env);
  assert.match(broken.systemMessage, /jevcomp is off/);
  assert.equal(await readFile(settingsFile, 'utf8'), '{ broken');
});
