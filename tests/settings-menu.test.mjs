import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSettingsMenu } from '../dist/settings-menu.js';
import { userSettings } from '../dist/settings.js';

function fakeTerminal() {
  const input = new EventEmitter();
  input.resume = () => {};
  input.pause = () => {};
  input.setRawMode = () => {};
  let screen = '';
  return { input, output: { write: (text) => { screen += text; } }, screen: () => screen };
}

async function press(terminal, run, keys) {
  for (const key of keys) {
    terminal.input.emit('data', key);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await run;
}

test('arrow keys change and save settings without typing names', async () => {
  const env = { JEVCOMP_CONFIG_DIR: await mkdtemp(join(tmpdir(), 'jevcomp-menu-')) };
  const terminal = fakeTerminal();
  const run = runSettingsMenu(terminal, env, 'codex');
  await press(terminal, run, ['\x1b[C', '\x1b']);
  const settings = userSettings(env, 'codex');
  assert.equal(settings.pinRecentMessages, 8);
  assert.match(terminal.screen(), /Recent messages never cut/);
  assert.doesNotMatch(terminal.screen(), /restore-mode|restore-max-chars/);
});

test('a setting decided by an environment variable is explained, not changed', async () => {
  const env = { JEVCOMP_CONFIG_DIR: await mkdtemp(join(tmpdir(), 'jevcomp-menu-env-')), JEVCOMP_LOSS_THRESHOLD: '0.7' };
  const terminal = fakeTerminal();
  const run = runSettingsMenu(terminal, env, 'codex');
  await press(terminal, run, ['\x1b[B', '\x1b[C', 'q']);
  assert.equal(userSettings({ JEVCOMP_CONFIG_DIR: env.JEVCOMP_CONFIG_DIR }, 'codex').lossThreshold, 0.5);
  assert.match(terminal.screen(), /JEVCOMP_LOSS_THRESHOLD is set in your environment/);
});

test('the last row resets everything to defaults', async () => {
  const env = { JEVCOMP_CONFIG_DIR: await mkdtemp(join(tmpdir(), 'jevcomp-menu-reset-')) };
  const terminal = fakeTerminal();
  const run = runSettingsMenu(terminal, env, 'codex');
  await press(terminal, run, ['\x1b[C', '\x1b[A', '\r', '\x03']);
  assert.equal(userSettings(env, 'codex').pinRecentMessages, 6);
  assert.match(terminal.screen(), /back to their defaults/);
});
