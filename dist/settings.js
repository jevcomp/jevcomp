import { readFileSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { configDir } from './provider.js';
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function sanitizeSavedSettings(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return {};
    const record = value;
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
export function settingsPath(env = process.env) {
    return env.JEVCOMP_SETTINGS_FILE ?? join(configDir(env), 'settings.json');
}
function saved(env) {
    try {
        return sanitizeSavedSettings(JSON.parse(String(readFileSync(settingsPath(env), 'utf8'))));
    }
    catch {
        return {};
    }
}
function envNumber(env, keys) {
    for (const key of keys) {
        const raw = env[key];
        if (raw === undefined || raw.trim() === '')
            continue;
        const n = Number(raw);
        if (Number.isFinite(n))
            return n;
    }
    return undefined;
}
function normalizedMode(value) {
    const v = (value ?? '').trim().toLowerCase();
    if (v === 'preserve' || v === 'full')
        return 'preserve';
    if (v === 'balanced' || v === 'hybrid')
        return 'balanced';
    if (v === 'minimal' || v === 'index')
        return 'minimal';
    return undefined;
}
const ENV_NAMES = {
    'restore-mode': ['JEVCOMP_RESTORE_MODE'],
    'restore-max-chars': ['JEVCOMP_RESTORE_MAX_CHARS', 'JEVCOMP_CONTEXT_CHARS'],
    'pin-recent-messages': ['JEVCOMP_PIN_RECENT_MESSAGES', 'JEVCOMP_PRESERVE_RECENT'],
    'loss-threshold': ['JEVCOMP_LOSS_THRESHOLD', 'JEVCOMP_KEEP_THRESHOLD'],
    'min-reduction-ratio': ['JEVCOMP_MIN_REDUCTION_RATIO', 'JEVCOMP_MIN_REDUCTION'],
};
/** Names the environment variable that wins over the saved value, if any. */
export function settingOverride(name, env = process.env) {
    return ENV_NAMES[name].find((key) => (env[key] ?? '').trim() !== '');
}
export function userSettings(env = process.env) {
    const stored = saved(env);
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
export async function setUserSetting(name, rawValue, env = process.env) {
    const current = saved(env);
    if (name === 'restore-mode') {
        const mode = normalizedMode(rawValue);
        if (!mode)
            throw new Error('restore-mode must be preserve, balanced, or minimal');
        current.restoreMode = mode;
    }
    else if (name === 'restore-max-chars' || name === 'pin-recent-messages') {
        const n = Number(rawValue);
        if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n))
            throw new Error(`${name} must be a non-negative integer`);
        if (name === 'restore-max-chars')
            current.restoreMaxChars = n;
        else
            current.pinRecentMessages = n;
    }
    else {
        const n = Number(rawValue);
        if (!Number.isFinite(n) || n < 0 || n > 1)
            throw new Error(`${name} must be between 0 and 1`);
        if (name === 'loss-threshold')
            current.lossThreshold = n;
        else
            current.minReductionRatio = n;
    }
    const path = settingsPath(env);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    try {
        await chmod(path, 0o600);
    }
    catch { }
    return userSettings(env);
}
export async function resetUserSettings(env = process.env) {
    await rm(settingsPath(env), { force: true });
}
