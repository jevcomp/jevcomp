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
    const pinRecentMessages = finiteNumber(record.pinRecentMessages);
    const lossThreshold = finiteNumber(record.lossThreshold);
    const minReductionRatio = finiteNumber(record.minReductionRatio);
    return {
        ...(pinRecentMessages !== undefined && pinRecentMessages >= 0 ? { pinRecentMessages: Math.floor(pinRecentMessages) } : {}),
        ...(lossThreshold !== undefined && lossThreshold >= 0 && lossThreshold <= 1 ? { lossThreshold } : {}),
        ...(minReductionRatio !== undefined && minReductionRatio >= 0 && minReductionRatio <= 1 ? { minReductionRatio } : {}),
    };
}
export function settingsPath(env = process.env) {
    return env.JEVCOMP_SETTINGS_FILE ?? join(configDir(env), 'settings.json');
}
const AGENTS = ['codex', 'claude', 'agy'];
// Settings saved before 0.7.3 sit at the top level; they become each agent's starting point, then disappear.
function savedByAgent(path) {
    let record;
    try {
        const parsed = JSON.parse(String(readFileSync(path, 'utf8')));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return {};
        record = parsed;
    }
    catch {
        return {};
    }
    const hasAgentSections = AGENTS.some((agent) => agent in record);
    const legacy = hasAgentSections ? {} : sanitizeSavedSettings(record);
    const byAgent = {};
    for (const agent of AGENTS) {
        const own = agent in record ? sanitizeSavedSettings(record[agent]) : legacy;
        if (Object.keys(own).length > 0)
            byAgent[agent] = own;
    }
    return byAgent;
}
async function writeSavedByAgent(path, byAgent) {
    if (Object.keys(byAgent).length === 0) {
        await rm(path, { force: true });
        return;
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(byAgent, null, 2)}\n`, { mode: 0o600 });
    try {
        await chmod(path, 0o600);
    }
    catch { }
}
function saved(env, agent) {
    return { ...savedByAgent(settingsPath(env))[agent] };
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
const ENV_NAMES = {
    'pin-recent-messages': ['JEVCOMP_PIN_RECENT_MESSAGES', 'JEVCOMP_PRESERVE_RECENT'],
    'loss-threshold': ['JEVCOMP_LOSS_THRESHOLD', 'JEVCOMP_KEEP_THRESHOLD'],
    'min-reduction-ratio': ['JEVCOMP_MIN_REDUCTION_RATIO', 'JEVCOMP_MIN_REDUCTION'],
};
/** Names the environment variable that wins over the saved value, if any. */
export function settingOverride(name, env = process.env) {
    return ENV_NAMES[name].find((key) => (env[key] ?? '').trim() !== '');
}
export function userSettings(env, agent) {
    const stored = saved(env, agent);
    const pinRecent = envNumber(env, ['JEVCOMP_PIN_RECENT_MESSAGES', 'JEVCOMP_PRESERVE_RECENT']) ?? stored.pinRecentMessages ?? 6;
    const loss = envNumber(env, ['JEVCOMP_LOSS_THRESHOLD', 'JEVCOMP_KEEP_THRESHOLD']) ?? stored.lossThreshold ?? 0.5;
    const minReduction = envNumber(env, ['JEVCOMP_MIN_REDUCTION_RATIO', 'JEVCOMP_MIN_REDUCTION']) ?? stored.minReductionRatio ?? 0.15;
    return {
        pinRecentMessages: Math.max(0, Math.floor(pinRecent)),
        lossThreshold: Math.min(1, Math.max(0, loss)),
        minReductionRatio: Math.min(1, Math.max(0, minReduction)),
    };
}
export async function setUserSetting(name, rawValue, env, agent) {
    const current = saved(env, agent);
    if (name === 'pin-recent-messages') {
        const n = Number(rawValue);
        if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n))
            throw new Error(`${name} must be a non-negative integer`);
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
    await writeSavedByAgent(path, { ...savedByAgent(path), [agent]: current });
    return userSettings(env, agent);
}
export async function resetUserSettings(env, agent) {
    const path = settingsPath(env);
    const byAgent = savedByAgent(path);
    delete byAgent[agent];
    await writeSavedByAgent(path, byAgent);
}
