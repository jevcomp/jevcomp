import { readFileSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { configDir, type Env } from './provider.js';

export type RestoreMode = 'preserve' | 'balanced' | 'minimal';
export type SettingsAgent = 'codex' | 'claude' | 'agy';
export type SettingName = 'restore-mode' | 'restore-max-chars' | 'pin-recent-messages' | 'loss-threshold' | 'min-reduction-ratio';

interface SavedSettings {
  restoreMode?: RestoreMode;
  restoreMaxChars?: number;
  pinRecentMessages?: number;
  lossThreshold?: number;
  minReductionRatio?: number;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sanitizeSavedSettings(value: unknown): SavedSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const restoreMode = typeof record.restoreMode === 'string' ? normalizedMode(record.restoreMode) : undefined;
  const restoreMaxChars = finiteNumber(record.restoreMaxChars);
  const pinRecentMessages = finiteNumber(record.pinRecentMessages);
  const lossThreshold = finiteNumber(record.lossThreshold);
  const minReductionRatio = finiteNumber(record.minReductionRatio);
  return {
    ...(restoreMode ? { restoreMode } : {}),
    ...(restoreMaxChars !== undefined && restoreMaxChars >= 0 ? { restoreMaxChars: Math.floor(restoreMaxChars) } : {}),
    ...(pinRecentMessages !== undefined && pinRecentMessages >= 0 ? { pinRecentMessages: Math.floor(pinRecentMessages) } : {}),
    ...(lossThreshold !== undefined && lossThreshold >= 0 && lossThreshold <= 1 ? { lossThreshold } : {}),
    ...(minReductionRatio !== undefined && minReductionRatio >= 0 && minReductionRatio <= 1 ? { minReductionRatio } : {}),
  };
}

export interface UserSettings {
  restoreMode: RestoreMode;
  restoreModeWarning?: string;
  restoreMaxChars: number;
  pinRecentMessages: number;
  lossThreshold: number;
  minReductionRatio: number;
}

export function settingsPath(env: Env = process.env): string {
  return env.JEVCOMP_SETTINGS_FILE ?? join(configDir(env), 'settings.json');
}

const AGENTS: readonly SettingsAgent[] = ['codex', 'claude', 'agy'];

// Settings saved before 0.7.3 sit at the top level; they become each agent's starting point, then disappear.
function savedByAgent(path: string): Partial<Record<SettingsAgent, SavedSettings>> {
  let record: Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(readFileSync(path, 'utf8')));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    record = parsed as Record<string, unknown>;
  } catch { return {}; }
  const hasAgentSections = AGENTS.some((agent) => agent in record);
  const legacy = hasAgentSections ? {} : sanitizeSavedSettings(record);
  const byAgent: Partial<Record<SettingsAgent, SavedSettings>> = {};
  for (const agent of AGENTS) {
    const own = agent in record ? sanitizeSavedSettings(record[agent]) : legacy;
    if (Object.keys(own).length > 0) byAgent[agent] = own;
  }
  return byAgent;
}

async function writeSavedByAgent(path: string, byAgent: Partial<Record<SettingsAgent, SavedSettings>>): Promise<void> {
  if (Object.keys(byAgent).length === 0) { await rm(path, { force: true }); return; }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(byAgent, null, 2)}\n`, { mode: 0o600 });
  try { await chmod(path, 0o600); } catch {}
}

function saved(env: Env, agent: SettingsAgent): SavedSettings {
  return { ...savedByAgent(settingsPath(env))[agent] };
}

function envNumber(env: Env, keys: string[]): number | undefined {
  for (const key of keys) {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function normalizedMode(value: string | undefined): RestoreMode | undefined {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'preserve' || v === 'full') return 'preserve';
  if (v === 'balanced' || v === 'hybrid') return 'balanced';
  if (v === 'minimal' || v === 'index') return 'minimal';
  return undefined;
}

const ENV_NAMES: Record<SettingName, string[]> = {
  'restore-mode': ['JEVCOMP_RESTORE_MODE'],
  'restore-max-chars': ['JEVCOMP_RESTORE_MAX_CHARS', 'JEVCOMP_CONTEXT_CHARS'],
  'pin-recent-messages': ['JEVCOMP_PIN_RECENT_MESSAGES', 'JEVCOMP_PRESERVE_RECENT'],
  'loss-threshold': ['JEVCOMP_LOSS_THRESHOLD', 'JEVCOMP_KEEP_THRESHOLD'],
  'min-reduction-ratio': ['JEVCOMP_MIN_REDUCTION_RATIO', 'JEVCOMP_MIN_REDUCTION'],
};

/** Names the environment variable that wins over the saved value, if any. */
export function settingOverride(name: SettingName, env: Env = process.env): string | undefined {
  return ENV_NAMES[name].find((key) => (env[key] ?? '').trim() !== '');
}

export function userSettings(env: Env, agent: SettingsAgent): UserSettings {
  const stored = saved(env, agent);
  const rawMode = env.JEVCOMP_RESTORE_MODE;
  const modeFromEnv = normalizedMode(rawMode);
  // Codex compaction costs the same with or without jevcomp, so by default it adds back only the short list.
  const restoreMode = modeFromEnv ?? stored.restoreMode ?? 'minimal';
  const rawModeNormalized = (rawMode ?? '').trim().toLowerCase();
  const restoreModeWarning = rawMode !== undefined && rawModeNormalized !== '' && !modeFromEnv
    ? `unknown restore mode ${JSON.stringify(rawModeNormalized)}; using ${stored.restoreMode ?? 'minimal'}`
    : undefined;
  const restoreMax = envNumber(env, ['JEVCOMP_RESTORE_MAX_CHARS', 'JEVCOMP_CONTEXT_CHARS']) ?? stored.restoreMaxChars ?? 60_000;
  const pinRecent = envNumber(env, ['JEVCOMP_PIN_RECENT_MESSAGES', 'JEVCOMP_PRESERVE_RECENT']) ?? stored.pinRecentMessages ?? 6;
  const loss = envNumber(env, ['JEVCOMP_LOSS_THRESHOLD', 'JEVCOMP_KEEP_THRESHOLD']) ?? stored.lossThreshold ?? 0.5;
  const minReduction = envNumber(env, ['JEVCOMP_MIN_REDUCTION_RATIO', 'JEVCOMP_MIN_REDUCTION']) ?? stored.minReductionRatio ?? 0.15;
  return {
    restoreMode,
    restoreModeWarning,
    restoreMaxChars: Math.max(0, Math.floor(restoreMax)),
    pinRecentMessages: Math.max(0, Math.floor(pinRecent)),
    lossThreshold: Math.min(1, Math.max(0, loss)),
    minReductionRatio: Math.min(1, Math.max(0, minReduction)),
  };
}

export async function setUserSetting(name: SettingName, rawValue: string, env: Env, agent: SettingsAgent): Promise<UserSettings> {
  const current = saved(env, agent);
  if (name === 'restore-mode') {
    const mode = normalizedMode(rawValue);
    if (!mode) throw new Error('restore-mode must be preserve, balanced, or minimal');
    current.restoreMode = mode;
  } else if (name === 'restore-max-chars' || name === 'pin-recent-messages') {
    const n = Number(rawValue);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) throw new Error(`${name} must be a non-negative integer`);
    if (name === 'restore-max-chars') current.restoreMaxChars = n;
    else current.pinRecentMessages = n;
  } else {
    const n = Number(rawValue);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`${name} must be between 0 and 1`);
    if (name === 'loss-threshold') current.lossThreshold = n;
    else current.minReductionRatio = n;
  }
  const path = settingsPath(env);
  await writeSavedByAgent(path, { ...savedByAgent(path), [agent]: current });
  return userSettings(env, agent);
}

export async function resetUserSettings(env: Env, agent: SettingsAgent): Promise<void> {
  const path = settingsPath(env);
  const byAgent = savedByAgent(path);
  delete byAgent[agent];
  await writeSavedByAgent(path, byAgent);
}
