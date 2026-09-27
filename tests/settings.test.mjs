import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetUserSettings, setUserSetting, settingsPath, userSettings } from '../dist/settings.js';

test('user-facing settings persist without shell environment variables', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-settings-'));
  const env = { JEVCOMP_CONFIG_DIR: root };
  await setUserSetting('restore-mode', 'balanced', env, 'codex');
  await setUserSetting('restore-max-chars', '42000', env, 'codex');
  await setUserSetting('pin-recent-messages', '9', env, 'codex');
  await setUserSetting('loss-threshold', '0.35', env, 'codex');
  await setUserSetting('min-reduction-ratio', '0.2', env, 'codex');
  const value = userSettings(env, 'codex');
  assert.deepEqual({
    restoreMode: value.restoreMode,
    restoreMaxChars: value.restoreMaxChars,
    pinRecentMessages: value.pinRecentMessages,
    lossThreshold: value.lossThreshold,
    minReductionRatio: value.minReductionRatio,
  }, { restoreMode: 'balanced', restoreMaxChars: 42000, pinRecentMessages: 9, lossThreshold: 0.35, minReductionRatio: 0.2 });
  assert.match(await readFile(settingsPath(env), 'utf8'), /"codex": \{[\s\S]*"restoreMode": "balanced"/);
});

test('environment variables override saved user settings and reset restores defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-settings-override-'));
  const base = { JEVCOMP_CONFIG_DIR: root };
  await setUserSetting('restore-mode', 'minimal', base, 'codex');
  await setUserSetting('loss-threshold', '0.2', base, 'codex');
  const overridden = userSettings({ ...base, JEVCOMP_RESTORE_MODE: 'preserve', JEVCOMP_LOSS_THRESHOLD: '0.7' }, 'codex');
  assert.equal(overridden.restoreMode, 'preserve');
  assert.equal(overridden.lossThreshold, 0.7);
  await resetUserSettings(base, 'codex');
  const defaults = userSettings(base, 'codex');
  assert.equal(defaults.restoreMode, 'minimal');
  assert.equal(defaults.lossThreshold, 0.5);
});

test('invalid persisted values are rejected before they can affect hooks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-settings-invalid-'));
  const env = { JEVCOMP_CONFIG_DIR: root };
  await assert.rejects(setUserSetting('loss-threshold', '2', env, 'codex'), /between 0 and 1/);
  await assert.rejects(setUserSetting('restore-max-chars', '-1', env, 'codex'), /non-negative integer/);
  await assert.rejects(setUserSetting('restore-mode', 'fastest', env, 'codex'), /must be preserve/);
});

test('manually corrupted settings file is sanitized back to safe defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-settings-corrupt-'));
  const env = { JEVCOMP_CONFIG_DIR: root };
  await writeFile(settingsPath(env), JSON.stringify({
    mode: 'turbo',
    restoreMode: 'turbo',
    restoreMaxChars: 'huge',
    pinRecentMessages: -3,
    lossThreshold: 8,
    minReductionRatio: null,
  }));
  const value = userSettings(env, 'codex');
  assert.equal(value.restoreMode, 'minimal');
  assert.equal(value.restoreMaxChars, 60000);
  assert.equal(value.pinRecentMessages, 6);
  assert.equal(value.lossThreshold, 0.5);
  assert.equal(value.minReductionRatio, 0.15);
});

test('a mode saved by an older version is ignored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-settings-old-mode-'));
  const env = { JEVCOMP_CONFIG_DIR: root, JEVCOMP_MODE: 'observe' };
  await writeFile(settingsPath(env), JSON.stringify({ mode: 'observe', restoreMode: 'balanced' }));
  const value = userSettings(env, 'codex');
  assert.equal('mode' in value, false);
  assert.equal(value.restoreMode, 'balanced');
});

test('settings are isolated by agent, legacy values seed every agent, and reset is scoped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-settings-agents-'));
  const env = { JEVCOMP_CONFIG_DIR: root };
  await writeFile(settingsPath(env), JSON.stringify({ restoreMode: 'balanced' }));
  for (const agent of ['codex', 'claude', 'agy']) assert.equal(userSettings(env, agent).restoreMode, 'balanced');
  await setUserSetting('restore-mode', 'preserve', env, 'claude');
  assert.equal(userSettings(env, 'claude').restoreMode, 'preserve');
  assert.equal(userSettings(env, 'codex').restoreMode, 'balanced');
  await setUserSetting('loss-threshold', '0.7', env, 'codex');
  await resetUserSettings(env, 'claude');
  assert.equal(userSettings(env, 'codex').lossThreshold, 0.7);
  assert.equal(userSettings(env, 'claude').restoreMode, 'minimal');
  const saved = JSON.parse(await readFile(settingsPath(env), 'utf8'));
  assert.equal(saved.restoreMode, undefined);
  assert.equal(saved.agy.restoreMode, 'balanced');
  assert.equal('claude' in saved, false);
});

test('settings saved before 0.7.3 start every agent and reset really returns to defaults', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jevcomp-legacy-settings-'));
  const env = { JEVCOMP_SETTINGS_FILE: join(dir, 'settings.json') };
  await writeFile(env.JEVCOMP_SETTINGS_FILE, JSON.stringify({ minReductionRatio: 0.4 }));
  const { userSettings, resetUserSettings } = await import('../dist/settings.js');
  const defaults = userSettings({ JEVCOMP_SETTINGS_FILE: join(dir, 'none.json') }, 'codex').minReductionRatio;
  assert.equal(userSettings(env, 'claude').minReductionRatio, 0.4);
  await resetUserSettings(env, 'codex');
  assert.equal(userSettings(env, 'codex').minReductionRatio, defaults);
  assert.equal(userSettings(env, 'claude').minReductionRatio, 0.4);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(env.JEVCOMP_SETTINGS_FILE, 'utf8'))).sort(), ['agy', 'claude']);
});
