import { appendFile, chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { legacyHistoryPaths } from './legacy.js';
import { enabledPluginDataDir } from './plugin-installation.js';
import type { CallDecision, CompactStats, Message } from './types.js';

export interface SessionState {
  version: 1;
  sessionId: string;
  runId?: string;
  turnId?: string;
  trigger?: string;
  model?: string;
  transcriptPath?: string;
  transcriptBytesAtScore?: number;
  createdAt: string;
  ready: boolean;
  consumed: boolean;
  contextFile: string;
  messagesFile?: string;
  index: string;
  contextChars: number;
  stats: CompactStats;
  decisions: CallDecision[];
}

export interface HistoryRow {
  at: string;
  runId?: string;
  sessionId: string;
  turnId?: string;
  trigger?: string;
  model?: string;
  provider?: string;
  /** Absent on rows written before Claude Code support, which all came from Codex. */
  host?: 'codex' | 'claude' | 'agy';
  phase?: 'precompact' | 'postcompact' | 'restore';
  status: 'prepared' | 'ready' | 'restored' | 'skipped' | 'failed';
  stats?: CompactStats;
  decisions?: CallDecision[];
  detail?: string;
  restoreMode?: 'preserve' | 'balanced' | 'minimal';
  restoreLimitChars?: number;
  injectedChars?: number;
  injectedPayloadChars?: number;
  retainedChars?: number;
  /** Retained normalized characters proven to already exist after native compaction. */
  nativePresentChars?: number;
  /** Retained normalized characters still missing after exact post-compaction membership checks. */
  restoreCandidateChars?: number;
  membershipStatus?: 'verified' | 'unavailable' | 'stale';
  dedupedTextItems?: number;
  dedupedToolPairs?: number;
}

function safe(value: string): string { return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 180); }

/** One folder for every agent, so the Codex and Claude Code plugins share history and the dashboard. */
export function dataDir(env = process.env): string {
  return env.JEVCOMP_DATA_DIR ?? join(homedir(), '.jevcomp');
}
/** JEVCOMP_CAPTURE=1 saves under ~/.jevcomp; any other value is taken as the folder itself. */
export function captureDirectory(env: Record<string, string | undefined>, folder: string): string | undefined {
  const value = env.JEVCOMP_CAPTURE?.trim();
  if (!value || value === '0') return undefined;
  return value === '1' ? join(dataDir(env), folder) : value;
}
export function statePath(sessionId: string, env = process.env): string { return join(dataDir(env), 'sessions', `${safe(sessionId)}.json`); }
export function contextPath(sessionId: string, env = process.env): string { return join(dataDir(env), 'sessions', `${safe(sessionId)}.context.txt`); }
export function messagesPath(sessionId: string, env = process.env): string { return join(dataDir(env), 'sessions', `${safe(sessionId)}.messages.json`); }
export function historyPath(env = process.env): string { return join(dataDir(env), 'history.jsonl'); }

export function readableHistoryPaths(env = process.env): string[] {
  const current = historyPath(env);
  if (env.JEVCOMP_DATA_DIR) return [current];
  // Versions before 0.7.0 kept data in the Codex folders.
  const standalone = join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'jevcomp', 'history.jsonl');
  const pluginData = [env.PLUGIN_DATA, enabledPluginDataDir(env)].filter((dir): dir is string => !!dir).map((dir) => join(dir, 'history.jsonl'));
  return [...new Set([...legacyHistoryPaths(env), standalone, ...pluginData, current])];
}

async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  try { await chmod(path, 0o700); } catch {}
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, path);
  } finally {
    try { await rm(tmp, { force: true }); } catch {}
  }
}

export async function prepareState(
  state: Omit<SessionState, 'version' | 'ready' | 'consumed' | 'contextFile' | 'contextChars' | 'messagesFile'>,
  context: string,
  env = process.env,
  messages?: readonly Message[],
): Promise<SessionState> {
  const cp = contextPath(state.sessionId, env);
  const mp = messages?.length ? messagesPath(state.sessionId, env) : undefined;
  const full: SessionState = {
    version: 1,
    ...state,
    ready: false,
    consumed: false,
    contextFile: cp,
    ...(mp ? { messagesFile: mp } : {}),
    contextChars: context.length,
  };
  const archiveWrites = [atomicWrite(cp, context)];
  if (mp) archiveWrites.push(atomicWrite(mp, `${JSON.stringify(messages)}\n`));
  // Publish the state only after both archives are durable; archive writes are independent.
  await Promise.all(archiveWrites);
  await atomicWrite(statePath(state.sessionId, env), JSON.stringify(full));
  return full;
}

export async function discardPendingState(sessionId: string, env = process.env): Promise<void> {
  try { await rm(statePath(sessionId, env), { force: true }); } catch {}
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
    return code === 'EPERM';
  }
}

async function recoverOrphanClaim(path: string): Promise<void> {
  let names: string[];
  try { names = await readdir(dirname(path)); } catch { return; }
  const base = path.slice(dirname(path).length + 1);
  const prefix = `${base}.`;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.claim')) continue;
    const rawPid = name.slice(prefix.length, -'.claim'.length);
    const pid = Number(rawPid);
    if (processAlive(pid)) continue;
    try { await rename(join(dirname(path), name), path); return; } catch {}
  }
}

export async function readState(sessionId: string, env = process.env): Promise<SessionState | undefined> {
  const path = statePath(sessionId, env);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as SessionState;
      return parsed?.version === 1 ? parsed : undefined;
    } catch (error) {
      if (attempt === 0 && error && typeof error === 'object' && 'code' in error && String((error as { code?: unknown }).code) === 'ENOENT') {
        await recoverOrphanClaim(path);
        continue;
      }
      return undefined;
    }
  }
  return undefined;
}


function validReadyState(parsed: SessionState, ttlMs: number): boolean {
  const age = Date.now() - Date.parse(parsed.createdAt);
  return parsed.version === 1 && parsed.ready && !parsed.consumed && Number.isFinite(age) && age >= 0 && age <= ttlMs;
}

export async function peekReady(sessionId: string, ttlMs: number, env = process.env): Promise<SessionState | undefined> {
  const state = await readState(sessionId, env);
  return state && validReadyState(state, ttlMs) ? state : undefined;
}

export async function markReady(sessionId: string, turnId?: string, env = process.env): Promise<SessionState | undefined> {
  const state = await readState(sessionId, env);
  if (!state || (state.turnId && turnId && state.turnId !== turnId)) return undefined;
  const next = { ...state, ready: true };
  await atomicWrite(statePath(sessionId, env), JSON.stringify(next));
  return next;
}

export async function claimReady(sessionId: string, ttlMs: number, env = process.env, expectedCreatedAt?: string): Promise<SessionState | undefined> {
  const path = statePath(sessionId, env);
  const claim = `${path}.${process.pid}.claim`;
  try { await rename(path, claim); }
  catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || String((error as { code?: unknown }).code) !== 'ENOENT') return undefined;
    await recoverOrphanClaim(path);
    try { await rename(path, claim); } catch { return undefined; }
  }
  let state: SessionState | undefined;
  try {
    const parsed = JSON.parse(await readFile(claim, 'utf8')) as SessionState;
    if (validReadyState(parsed, ttlMs) && (!expectedCreatedAt || parsed.createdAt === expectedCreatedAt)) state = parsed;
    const next = { ...parsed, consumed: !!state || parsed.consumed };
    await atomicWrite(path, JSON.stringify(next));
  } catch {
    try { await rename(claim, path); } catch {}
    return undefined;
  }
  try { await rm(claim, { force: true }); } catch {}
  return state;
}

/** Best-effort cleanup of stale per-session sidecars. History is intentionally retained. */
export async function sweep(env = process.env, maxAgeMs = 48 * 60 * 60 * 1000): Promise<number> {
  const dir = join(dataDir(env), 'sessions');
  const cutoff = Date.now() - Math.max(0, maxAgeMs);
  let removed = 0;
  let names: string[];
  try { names = await readdir(dir); } catch { return 0; }
  for (const name of names) {
    if (!/\.(?:json|txt|claim)$/.test(name)) continue;
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (info.mtimeMs < cutoff) { await rm(path, { force: true }); removed++; }
    } catch {}
  }
  return removed;
}

export async function appendHistory(row: HistoryRow, env = process.env): Promise<void> {
  const path = historyPath(env);
  await ensurePrivateDir(dirname(path));
  await appendFile(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

/** History is observability only; hook correctness must never depend on this write succeeding. */
export async function tryAppendHistory(row: HistoryRow, env = process.env): Promise<boolean> {
  try { await appendHistory(row, env); return true; } catch { return false; }
}

export async function readHistory(env = process.env): Promise<HistoryRow[]> {
  const rows = new Map<string, HistoryRow>();
  for (const path of readableHistoryPaths(env)) {
    let lines: string[];
    try { lines = (await readFile(path, 'utf8')).split(/\r?\n/); }
    catch { continue; }
    for (const line of lines) {
      if (!line) continue;
      let row: HistoryRow;
      try { row = JSON.parse(line) as HistoryRow; } catch { continue; }
      if (!row || typeof row !== 'object' || typeof row.at !== 'string' || typeof row.sessionId !== 'string' || typeof row.status !== 'string') continue;
      const key = row.runId ? `${row.sessionId}\u0000${row.runId}\u0000${row.phase ?? ''}\u0000${row.status}` : line;
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort((left, right) => left.at.localeCompare(right.at));
}

export type HookActivity = Partial<Record<'SessionStart' | 'UserPromptSubmit' | 'PreCompact' | 'PostCompact', string>>;

export function hookActivityPath(env = process.env): string { return join(dataDir(env), 'hook-activity.json'); }

export async function readHookActivity(env = process.env): Promise<HookActivity> {
  try {
    const value = JSON.parse(await readFile(hookActivityPath(env), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as HookActivity : {};
  } catch { return {}; }
}

/** Remembers when Codex last ran each hook, as proof the hooks are active. */
export async function recordHookActivity(event: string, env = process.env): Promise<void> {
  if (!['SessionStart', 'UserPromptSubmit', 'PreCompact', 'PostCompact'].includes(event)) return;
  const activity = { ...await readHookActivity(env), [event]: new Date().toISOString() };
  await ensurePrivateDir(dataDir(env));
  await writeFile(hookActivityPath(env), JSON.stringify(activity), { mode: 0o600 });
}
