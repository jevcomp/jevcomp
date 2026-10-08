import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

type Env = Record<string, string | undefined>;
export type AgentProxyKind = 'codex' | 'agy';

interface ProxySpec {
  command: string;
  service: string;
  port: number;
  portEnv: string;
}

const SPECS: Record<AgentProxyKind, ProxySpec> = {
  codex: { command: 'codex-proxy', service: 'jevcomp-codex-proxy', port: 16_393, portEnv: 'JEVCOMP_CODEX_PROXY_PORT' },
  agy: { command: 'agy-proxy', service: 'jevcomp-agy-proxy', port: 16_394, portEnv: 'JEVCOMP_AGY_PROXY_PORT' },
};

export interface AgentProxyInstance {
  pid: number;
  instanceId: string;
  url: string;
  build: string;
  config: string;
  version?: string;
}

const defaultCliPath = fileURLToPath(new URL('./cli.js', import.meta.url));

export function agentProxyPort(kind: AgentProxyKind, env: Env = process.env): number {
  const spec = SPECS[kind];
  const value = Number(env[spec.portEnv]);
  return Number.isInteger(value) && value > 0 && value < 65_536 ? value : spec.port;
}

export function agentProxyUrl(kind: AgentProxyKind, env: Env = process.env): string {
  return `http://127.0.0.1:${agentProxyPort(kind, env)}`;
}

async function buildIdentity(): Promise<string> {
  const directory = fileURLToPath(new URL('.', import.meta.url));
  const names = (await readdir(directory)).filter((name: string) => name.endsWith('.js')).sort();
  const hash = createHash('sha256');
  for (const name of names) {
    hash.update(name);
    try { hash.update(await readFile(new URL(name, import.meta.url))); }
    catch { hash.update(':unavailable'); }
  }
  return hash.digest('hex');
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !!error && typeof error === 'object' && 'code' in error && error.code === 'EPERM'; }
}

export async function runningAgentProxy(kind: AgentProxyKind, env: Env = process.env): Promise<AgentProxyInstance | undefined> {
  const spec = SPECS[kind];
  const url = agentProxyUrl(kind, env);
  try {
    const response = await fetch(`${url}/__jevcomp/health`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return undefined;
    const health = await response.json() as Record<string, unknown>;
    if (health.service !== spec.service || !Number.isSafeInteger(health.pid) || Number(health.pid) <= 0 ||
        typeof health.instanceId !== 'string' || typeof health.build !== 'string' || typeof health.config !== 'string') return undefined;
    const pid = Number(health.pid);
    if (!processAlive(pid)) return undefined;
    return {
      pid,
      instanceId: health.instanceId,
      url,
      build: health.build,
      config: health.config,
      ...(typeof health.version === 'string' ? { version: health.version } : {}),
    };
  } catch { return undefined; }
}

async function stopOwnedInstance(kind: AgentProxyKind, instance: AgentProxyInstance, env: Env): Promise<void> {
  try { process.kill(instance.pid); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) throw error;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!await runningAgentProxy(kind, env)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  if (await runningAgentProxy(kind, env)) throw new Error(`${kind} proxy did not stop`);
}

export async function stopAgentProxy(kind: AgentProxyKind, env: Env = process.env): Promise<void> {
  const running = await runningAgentProxy(kind, env);
  if (running) await stopOwnedInstance(kind, running, env);
}

async function spawnProxy(kind: AgentProxyKind, config: string, build: string, env: Env, cliPath: string): Promise<AgentProxyInstance> {
  const spec = SPECS[kind];
  const port = agentProxyPort(kind, env);
  const instanceId = randomUUID();
  const child = spawn(process.execPath, [cliPath, spec.command, '--port', String(port), '--background'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...env,
      JEVCOMP_AGENT_PROXY_INSTANCE_ID: instanceId,
      JEVCOMP_AGENT_PROXY_BUILD: build,
      JEVCOMP_AGENT_PROXY_CONFIG: config,
    },
  });
  child.unref();
  return new Promise<AgentProxyInstance>((resolve, reject) => {
    let stdout = '', stderr = '', settled = false;
    const timeout = setTimeout(() => finish(new Error(`${kind} proxy did not start within 15 seconds`)), 15_000);
    const finish = (error?: Error, instance?: AgentProxyInstance) => {
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
      void runningAgentProxy(kind, env).then((instance) => {
        if (instance?.instanceId === instanceId) finish(undefined, instance);
      });
    });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error: Error) => finish(error));
    child.once('exit', (code: number | null) => finish(new Error(stderr.trim() || `${kind} proxy process exited (${code})`)));
  });
}

export async function ensureAgentProxy(kind: AgentProxyKind, config: string, env: Env = process.env, cliPath = defaultCliPath): Promise<AgentProxyInstance> {
  const build = await buildIdentity();
  const running = await runningAgentProxy(kind, env);
  if (running && running.build === build && running.config === config) return running;
  if (running) await stopOwnedInstance(kind, running, env);
  return spawnProxy(kind, config, build, env, cliPath);
}
