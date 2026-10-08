import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { dataDir } from './store.js';

export type ClaudeGatewayEnv = Record<string, string | undefined>;

export interface ClaudeGatewayInstance {
  pid: number;
  instanceId: string;
  url: string;
  upstream: string;
  build: string;
  version?: string;
}

export const DEFAULT_CLAUDE_GATEWAY_PORT = 16_392;
export const CLAUDE_GATEWAY_SERVICE = 'jevcomp-claude-gateway';
const defaultCliPath = fileURLToPath(new URL('./cli.js', import.meta.url));

export function claudeGatewayPort(env: ClaudeGatewayEnv = process.env): number {
  const value = Number(env.JEVCOMP_CLAUDE_GATEWAY_PORT);
  return Number.isInteger(value) && value > 0 && value < 65_536 ? value : DEFAULT_CLAUDE_GATEWAY_PORT;
}

export function claudeGatewayUrl(env: ClaudeGatewayEnv = process.env): string {
  return `http://127.0.0.1:${claudeGatewayPort(env)}`;
}

export function claudeGatewayInstancePath(port: number, env: ClaudeGatewayEnv = process.env): string {
  return join(dataDir(env), `claude-gateway-${port}.json`);
}

async function buildIdentity(): Promise<string> {
  const hash = createHash('sha256');
  for (const name of ['claude-proxy.js', 'claude-gateway-service.js']) {
    try { hash.update(await readFile(fileURLToPath(new URL(name, import.meta.url)))); }
    catch { hash.update(`${name}:unavailable`); }
  }
  return hash.digest('hex');
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !!error && typeof error === 'object' && 'code' in error && error.code === 'EPERM'; }
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export async function runningClaudeGateway(port = claudeGatewayPort(), env: ClaudeGatewayEnv = process.env): Promise<ClaudeGatewayInstance | undefined> {
  const url = `http://127.0.0.1:${port}`;
  try {
    const response = await fetch(`${url}/__jevcomp/health`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return undefined;
    const health = await response.json() as Record<string, unknown>;
    if (health.service !== CLAUDE_GATEWAY_SERVICE || !Number.isSafeInteger(health.pid) || Number(health.pid) <= 0 ||
        typeof health.instanceId !== 'string' || typeof health.upstream !== 'string' || typeof health.build !== 'string') return undefined;
    const pid = Number(health.pid);
    if (!processAlive(pid)) return undefined;
    return { pid, instanceId: health.instanceId, url, upstream: health.upstream, build: health.build, ...(typeof health.version === 'string' ? { version: health.version } : {}) };
  } catch { return undefined; }
}

async function stopInstance(instance: ClaudeGatewayInstance, port: number, env: ClaudeGatewayEnv): Promise<void> {
  try { process.kill(instance.pid); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) throw error;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!await runningClaudeGateway(port, env)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await rm(claudeGatewayInstancePath(port, env), { force: true }).catch(() => {});
}

export async function stopClaudeGateway(env: ClaudeGatewayEnv = process.env): Promise<void> {
  const port = claudeGatewayPort(env);
  const running = await runningClaudeGateway(port, env);
  if (running) await stopInstance(running, port, env);
  else await rm(claudeGatewayInstancePath(port, env), { force: true }).catch(() => {});
}

async function spawnGateway(port: number, upstream: string, build: string, env: ClaudeGatewayEnv, cliPath: string): Promise<ClaudeGatewayInstance> {
  const instanceId = randomUUID();
  const child = spawn(process.execPath, [cliPath, 'claude-gateway', '--port', String(port), '--background'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...env,
      JEVCOMP_CLAUDE_GATEWAY_INSTANCE_ID: instanceId,
      JEVCOMP_CLAUDE_GATEWAY_UPSTREAM: upstream,
      JEVCOMP_CLAUDE_GATEWAY_BUILD: build,
    },
  });
  child.unref();
  return new Promise<ClaudeGatewayInstance>((resolve, reject) => {
    let stdout = '', stderr = '', settled = false;
    const timeout = setTimeout(() => finish(new Error('Claude gateway did not start within 15 seconds')), 15_000);
    const finish = (error?: Error, instance?: ClaudeGatewayInstance) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (error) reject(error);
      else resolve(instance!);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (!stdout.includes('\n')) return;
      void runningClaudeGateway(port, env).then(instance => {
        if (instance?.instanceId === instanceId) finish(undefined, instance);
      });
    });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error: Error) => finish(error));
    child.once('exit', (code: number | null) => finish(new Error(stderr.trim() || `Claude gateway process exited (${code})`)));
  });
}

export async function ensureClaudeGateway(upstream: string, env: ClaudeGatewayEnv = process.env, cliPath = defaultCliPath): Promise<ClaudeGatewayInstance> {
  const port = claudeGatewayPort(env);
  const build = await buildIdentity();
  const desiredUpstream = normalizeUrl(upstream);
  const running = await runningClaudeGateway(port, env);
  if (running && running.build === build && normalizeUrl(running.upstream) === desiredUpstream) return running;
  if (running) await stopInstance(running, port, env);
  return spawnGateway(port, desiredUpstream, build, env, cliPath);
}
