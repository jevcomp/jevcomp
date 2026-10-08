import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codexArguments, runCodex, startCodexProxy } from '../dist/codex-proxy.js';

test('Codex install writes its marker without creating hook configuration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jev-codex-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config');
  const hooks = join(root, 'hooks.json');
  const env = { ...process.env, JEVCOMP_CONFIG_DIR: config, CODEX_HOME: join(root, 'codex'), CODEX_HOOKS_FILE: hooks, TYPESAFE_API_KEY: 'test-key' };
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'install', 'typesafe', 'codex'], {
    cwd: root,
    encoding: 'utf8',
    input: '',
    env,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes('Connected to Codex. Start it with `jevcomp codex`.'), true);
  assert.equal(await import('node:fs/promises').then(({ readFile }) => readFile(join(config, 'codex-installed'), 'utf8')), '');
  await assert.rejects(import('node:fs/promises').then(({ access }) => access(hooks)));
  const removed = spawnSync(process.execPath, [cli, 'uninstall', 'codex'], { cwd: root, encoding: 'utf8', env });
  assert.equal(removed.status, 0, removed.stderr);
  await assert.rejects(import('node:fs/promises').then(({ access }) => access(join(config, 'codex-installed'))));
});

test('jevcomp codex injects its provider, preserves args, returns child status and closes the proxy', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jev-codex-cli-'));
  await writeFile(join(root, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }));
  t.after(() => rm(root, { recursive: true, force: true }));

  let receivedPath;
  const upstream = createServer(async (request, response) => {
    receivedPath = request.url;
    for await (const _chunk of request) {}
    response.end('forwarded');
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const args = ['exec', '--json', 'prompt with spaces'];
  const env = { ...process.env, CODEX_HOME: root, JEVCOMP_CAPTURE: '' };
  let spawned;
  let dashboardAttempted = false;

  const code = await runCodex(args, env, {
    upstreams: { chatgpt: `${upstreamUrl}/backend-api/codex`, api: `${upstreamUrl}/v1` },
    startProxy: startCodexProxy,
    startDashboard: async () => {
      dashboardAttempted = true;
      throw new Error('dashboard unavailable');
    },
    spawn: (command, childArgs, options) => {
      spawned = { command, childArgs, options };
      const child = new EventEmitter();
      queueMicrotask(async () => {
        const baseOverride = childArgs.find((arg) => arg.startsWith('model_providers.jevcomp.base_url=')).slice('model_providers.jevcomp.base_url='.length);
        const baseUrl = JSON.parse(baseOverride);
        assert.equal(new URL(baseUrl).hostname, '127.0.0.1');
        assert.equal(new URL(baseUrl).pathname, '/v1');
        const response = await fetch(`${baseUrl}/responses`, { method: 'POST', body: '{"stream":true}' });
        assert.equal(await response.text(), 'forwarded');
        child.emit('close', 37, null);
      });
      return child;
    },
  });

  assert.equal(dashboardAttempted, true);
  assert.equal(code, 37);
  assert.equal(spawned.command, 'codex');
  assert.equal(spawned.options.env, env);
  assert.equal(spawned.options.stdio, 'inherit');
  assert.equal(spawned.childArgs[0], 'exec');
  assert.deepEqual(spawned.childArgs.slice(-2), args.slice(1));
  assert.equal(spawned.childArgs.includes('--no-daemon'), false);
  assert.ok(spawned.childArgs.includes('model_provider="jevcomp"'));
  assert.ok(spawned.childArgs.includes('model_providers.jevcomp.name="jevcomp"'));
  assert.ok(spawned.childArgs.includes('model_providers.jevcomp.requires_openai_auth=true'));
  assert.ok(spawned.childArgs.includes('model_providers.jevcomp.wire_api="responses"'));
  assert.ok(spawned.childArgs.includes('model_providers.jevcomp.supports_websockets=false'));
  assert.equal(receivedPath, '/backend-api/codex/responses');

  const baseOverride = spawned.childArgs.find((arg) => arg.startsWith('model_providers.jevcomp.base_url=')).slice('model_providers.jevcomp.base_url='.length);
  const baseUrl = JSON.parse(baseOverride);
  await assert.rejects(fetch(`${baseUrl}/responses`));
});

test('provider config follows each supported Codex command path and preserves user args', () => {
  const baseUrl = 'http://127.0.0.1:43123/v1';
  const providerArgs = [
    '-c', 'model_provider="jevcomp"',
    '-c', 'model_providers.jevcomp.name="jevcomp"',
    '-c', `model_providers.jevcomp.base_url=${JSON.stringify(baseUrl)}`,
    '-c', 'model_providers.jevcomp.requires_openai_auth=true',
    '-c', 'model_providers.jevcomp.wire_api="responses"',
    '-c', 'model_providers.jevcomp.supports_websockets=false',
  ];
  const vectors = [
    { args: ['exec', '--skip-git-repo-check', '-c', 'model_auto_compact_token_limit=30000', 'prompt'], before: 1 },
    { args: ['resume', '--last'], before: 1 },
    { args: ['review', '--uncommitted'], before: 1 },
    { args: ['fork', '--last'], before: 1 },
    { args: ['exec', 'resume', '--last'], before: 2 },
    { args: ['exec', 'review', '--uncommitted'], before: 2 },
    { args: ['exec', 'fork', '--last'], before: 2 },
  ];

  for (const { args, before } of vectors) {
    const result = codexArguments(baseUrl, args);
    assert.deepEqual(result, [
      ...args.slice(0, before),
      ...providerArgs,
      ...args.slice(before),
    ]);
  }
});

test('jevcomp codex opens plain Codex when the proxy cannot start', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'jev-codex-cli-'));
  await writeFile(join(root, 'auth.json'), '{not json');
  t.after(() => rm(root, { recursive: true, force: true }));
  let spawnedArgs;
  const code = await runCodex(['exec', 'oi'], { CODEX_HOME: root }, {
    spawn: (_command, childArgs) => {
      spawnedArgs = childArgs;
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(spawnedArgs, ['exec', 'oi']);
});
