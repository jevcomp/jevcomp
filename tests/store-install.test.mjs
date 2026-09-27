import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeLegacyHooks, runtimeDir } from '../dist/install.js';
import { handleHook } from '../dist/hooks.js';

test('legacy Codex hook cleanup preserves unrelated commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-mixed-hooks-'));
  const file = join(root, 'hooks.json');
  await writeFile(file, JSON.stringify({ hooks: { PreCompact: [{ matcher: 'manual', hooks: [
    { type: 'command', command: 'node legacy hook --jevcomp' },
    { type: 'command', command: 'node unrelated.js' },
  ] }] } }));
  await removeLegacyHooks({ CODEX_HOOKS_FILE: file });
  const config = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(config.hooks.PreCompact[0].matcher, 'manual');
  assert.deepEqual(config.hooks.PreCompact[0].hooks, [{ type: 'command', command: 'node unrelated.js' }]);
  assert.equal((await readdir(root)).filter((name) => name.startsWith('hooks.json.bak.')).length, 1);
});

test('hook entrypoint outside Claude returns without side effects', async () => {
  const result = await handleHook({ session_id: 's', hook_event_name: 'PreCompact' }, {});
  assert.deepEqual(result, { continue: true, suppressOutput: true });
});

test('custom Codex home locates the runtime directory for uninstall cleanup', () => {
  const root = 'C:/custom-codex';
  assert.equal(runtimeDir({ CODEX_HOME: root }), join(root, 'jevcomp', 'runtime'));
});
