import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { dashboardPort, ensureDashboard } from './dashboard-service.js';
import { providerConfig, resolveApiKey, resolveProvider, type JevProvider } from './provider.js';
import { userSettings } from './settings.js';

interface HookInput {
  session_id: string;
  hook_event_name: string;
  source?: string;
}

function num(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseInput(value: unknown): HookInput {
  if (!value || typeof value !== 'object') throw new Error('invalid hook input');
  const input = value as Record<string, unknown>;
  if (typeof input.session_id !== 'string' || typeof input.hook_event_name !== 'string') throw new Error('invalid hook input');
  return {
    session_id: input.session_id,
    hook_event_name: input.hook_event_name,
    source: typeof input.source === 'string' ? input.source : undefined,
  };
}

function requestedProvider(env: Record<string, string | undefined>): JevProvider | undefined {
  const value = env.JEVCOMP_PROVIDER;
  return value === 'typesafe' || value === 'openrouter' || value === 'auto' ? value : undefined;
}

async function dashboardNotice(env: Record<string, string | undefined>, options: HookOptions): Promise<string | undefined> {
  if (!options.startDashboard) return undefined;
  try { return `jevcomp dashboard: ${await ensureDashboard(dashboardPort(env), env)}`; }
  catch (error) { return `jevcomp dashboard unavailable: ${error instanceof Error ? error.message : String(error)}`; }
}

export interface HookOptions { startDashboard?: boolean }

/** Jev settings shared by the Codex proxy and Claude Code compaction. */
export function jevCompactOptions(env: Record<string, string | undefined>) {
  const provider = resolveProvider({ provider: requestedProvider(env), env });
  const transport = providerConfig({ provider, env });
  const settings = userSettings(env, 'codex');
  return {
    provider,
    env,
    model: transport.model,
    goal: env.JEVCOMP_GOAL,
    baseUrl: transport.baseUrl,
    lossThreshold: settings.lossThreshold,
    preserveRecentMessages: settings.pinRecentMessages,
    maxStateTokens: Math.max(1_000, num(env, 'JEVCOMP_MAX_STATE_TOKENS', 24_000)),
    maxRequestTokens: Math.max(2_000, num(env, 'JEVCOMP_MAX_REQUEST_TOKENS', 30_000)),
    truncateHeadChars: Math.max(0, num(env, 'JEVCOMP_TRUNCATE_HEAD_CHARS', 300)),
    maxConcurrentRequests: Math.max(1, num(env, 'JEVCOMP_CONCURRENCY', 4)),
    timeoutMs: Math.max(1, num(env, 'JEVCOMP_TIMEOUT_MS', 20_000)),
    retries: Math.max(0, num(env, 'JEVCOMP_RETRIES', 1)),
  };
}

const FUNCTION_HOOKS_FLAG = 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS';

/** Plugins cannot set environment variables, and Claude Code reads this one only at startup, from the user's settings. */
export async function enableFunctionHooks(env: Record<string, string | undefined>): Promise<string> {
  const path = join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json');
  try {
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('not a JSON object');
    const current = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env as Record<string, unknown> : {};
    if (current[FUNCTION_HOOKS_FLAG] !== '1') {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify({ ...settings, env: { ...current, [FUNCTION_HOOKS_FLAG]: '1' } }, null, 2)}\n`);
    }
    return `jevcomp turned on Claude Code function hooks in ${path}. Restart Claude Code to start using jevcomp.`;
  } catch {
    return `jevcomp is off: add "${FUNCTION_HOOKS_FLAG}": "1" under "env" in ${path} and restart Claude Code.`;
  }
}

async function claudeHook(input: HookInput, env: Record<string, string | undefined>, options: HookOptions): Promise<Record<string, unknown>> {
  if (input.hook_event_name !== 'SessionStart' || (input.source !== 'startup' && input.source !== 'resume')) return { continue: true, suppressOutput: true };
  const notices: string[] = [];
  if (env[FUNCTION_HOOKS_FLAG] !== '1') notices.push(await enableFunctionHooks(env));
  if (!env.CLAUDE_PLUGIN_OPTION_APIKEY && !resolveApiKey(resolveProvider({ provider: requestedProvider(env), env }), { env })) notices.push('jevcomp needs an API key: set OPENROUTER_API_KEY or TYPESAFE_API_KEY, or fill it in the plugin options.');
  const dashboard = await dashboardNotice(env, options);
  if (dashboard) notices.push(dashboard);
  return notices.length ? { continue: true, systemMessage: notices.join(' · ') } : { continue: true, suppressOutput: true };
}

export async function handleHook(value: unknown, env: Record<string, string | undefined> = process.env, options: HookOptions = {}): Promise<Record<string, unknown>> {
  const input = parseInput(value);
  if (!env.CLAUDE_PLUGIN_ROOT) return { continue: true, suppressOutput: true };
  return claudeHook(input, env, options);
}
