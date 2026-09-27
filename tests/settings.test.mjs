import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetUserSettings, setUserSetting, settingsPath, userSettings } from '../dist/settings.js';

test('user-facing settings persist without shell environment variables', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-settings-'));
  const env = { JEVCOMP_CONFIG_DIR: root };
  await setUserSetting('pin-recent-messages', '9', env, 'codex');
  await setUserSetting('loss-threshold', '0.35', env, 'codex');
  await setUserSetting('min-reduction-ratio', '0.2', env, 'codex');
  assert.deepEqual(userSettings(env, 'codex'), { pinRecentMessages: 9, lossThreshold: 0.35, minReductionRatio: 0.2 });
  assert.match(await readFile(settingsPath(env), 'utf8'), /"pinRecentMessages": 9/);
});

test('environment variables override saved settings and reset restores defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-settings-override-'));
  const base = { JEVCOMP_CONFIG_DIR: root };
  await setUserSetting('loss-threshold', '0.2', base, 'codex');
  const overridden = userSettings({ ...base, JEVCOMP_LOSS_THRESHOLD: '0.7' }, 'codex');
  assert.equal(overridden.lossThreshold, 0.7);
  await resetUserSettings(base, 'codex');
  assert.equal(userSettings(base, 'codex').lossThreshold, 0.5);
});

test('invalid persisted values are rejected before they affect compaction', async () => {
  const env = { JEVCOMP_CONFIG_DIR: await mkdtemp(join(tmpdir(), 'jev-settings-invalid-')) };
  await assert.rejects(setUserSetting('loss-threshold', '2', env, 'codex'), /between 0 and 1/);
  await assert.rejects(setUserSetting('pin-recent-messages', '-1', env, 'codex'), /non-negative integer/);
});

test('legacy restore settings are ignored', async () => {
  const env = { JEVCOMP_CONFIG_DIR: await mkdtemp(join(tmpdir(), 'jev-settings-old-')), JEVCOMP_RESTORE_MODE: 'preserve', JEVCOMP_RESTORE_MAX_CHARS: '1' };
  await writeFile(settingsPath(env), JSON.stringify({ restoreMode: 'preserve', restoreMaxChars: 1, pinRecentMessages: 8 }));
  assert.deepEqual(userSettings(env, 'codex'), { pinRecentMessages: 8, lossThreshold: 0.5, minReductionRatio: 0.15 });
});

test('settings stay isolated by agent, legacy values seed each agent, and reset is scoped', async () => {
  const env = { JEVCOMP_CONFIG_DIR: await mkdtemp(join(tmpdir(), 'jev-settings-agents-')) };
  await writeFile(settingsPath(env), JSON.stringify({ pinRecentMessages: 8 }));
  for (const agent of ['codex', 'claude', 'agy']) assert.equal(userSettings(env, agent).pinRecentMessages, 8);
  await setUserSetting('loss-threshold', '0.7', env, 'codex');
  await resetUserSettings(env, 'claude');
  assert.equal(userSettings(env, 'codex').lossThreshold, 0.7);
  assert.equal(userSettings(env, 'claude').lossThreshold, 0.5);
});
