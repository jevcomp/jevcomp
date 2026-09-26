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
  const run = runSettingsMenu(terminal, env);
  await press(terminal, run, ['\x1b[C', '\x1b[B', '\x1b[C', '\x1b']);
  const settings = userSettings(env);
  assert.equal(settings.restoreMode, 'preserve');
  assert.equal(settings.restoreMaxChars, 100_000);
  assert.match(terminal.screen(), /All the text/);
  assert.match(terminal.screen(), /The most text jevcomp sends to Codex/);
});

test('a setting decided by an environment variable is explained, not changed', async () => {
  const env = { JEVCOMP_CONFIG_DIR: await mkdtemp(join(tmpdir(), 'jevcomp-menu-env-')), JEVCOMP_RESTORE_MODE: 'minimal' };
  const terminal = fakeTerminal();
  const run = runSettingsMenu(terminal, env);
  await press(terminal, run, ['\x1b[C', 'q']);
  assert.equal(userSettings({ JEVCOMP_CONFIG_DIR: env.JEVCOMP_CONFIG_DIR }).restoreMode, 'minimal');
  assert.match(terminal.screen(), /JEVCOMP_RESTORE_MODE is set in your environment/);
});

test('the last row resets everything to defaults', async () => {
  const env = { JEVCOMP_CONFIG_DIR: await mkdtemp(join(tmpdir(), 'jevcomp-menu-reset-')) };
  const terminal = fakeTerminal();
  const run = runSettingsMenu(terminal, env);
  await press(terminal, run, ['\x1b[C', '\x1b[A', '\r', '\x03']);
  assert.equal(userSettings(env).restoreMode, 'minimal');
  assert.match(terminal.screen(), /back to their defaults/);
});
