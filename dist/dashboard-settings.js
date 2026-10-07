import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dashboardPort } from './dashboard-service.js';
import { configDir, keyStatus, resolveProvider, savePreferredProvider, saveProviderConfiguration } from './provider.js';
import { SETTINGS_ITEMS } from './settings-menu.js';
import { resetUserSettings, setUserSetting, settingOverride, userSettings } from './settings.js';
import { readHistory } from './store.js';
import { VERSION } from './version.js';
import { agyCaInstalled, agyCertificateThumbprint } from './agy-proxy.js';
import { experimentProgress, startExperiment, stopExperiment } from './experiment.js';
const agyDetection = new Map();
async function antigravityInstalled(env) {
    const key = env.JEVCOMP_AGY_HOME ?? join(homedir(), '.jevcomp', 'agy-ca');
    const cached = agyDetection.get(key);
    if (cached && Date.now() - cached.at < 60_000)
        return cached.installed;
    const thumbprint = await agyCertificateThumbprint(env);
    const installed = thumbprint ? agyCaInstalled(thumbprint) : false;
    agyDetection.set(key, { at: Date.now(), installed });
    return installed;
}
async function readJson(path) {
    try {
        return JSON.parse(await readFile(path, 'utf8')) ?? {};
    }
    catch {
        return {};
    }
}
async function claudeInstallation(env) {
    const home = env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
    const installed = (await readJson(join(home, 'plugins', 'installed_plugins.json'))).plugins ?? {};
    const settings = await readJson(join(home, 'settings.json'));
    const ids = Object.keys(installed).filter((id) => id.startsWith('jevcomp@') && settings.enabledPlugins?.[id] !== false);
    return ids.length ? { functionHooks: settings.env?.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS === '1' } : null;
}
export async function settingsSnapshot(env = process.env, agent = 'codex') {
    const settings = userSettings(env, agent);
    const history = await readHistory(env);
    const codexMarker = join(configDir(env), 'codex-installed');
    const codexInstalled = existsSync(codexMarker);
    const claude = await claudeInstallation(env);
    const agyInstalled = await antigravityInstalled(env);
    const measurement = await experimentProgress(env, agent);
    const lastJev = [...history].reverse().find((row) => row.phase === 'precompact' || (!row.phase && row.status === 'failed'));
    const settingValue = {
        'pin-recent-messages': String(settings.pinRecentMessages),
        'loss-threshold': String(settings.lossThreshold),
        'min-reduction-ratio': String(settings.minReductionRatio),
    };
    return {
        provider: resolveProvider({ env }),
        providerLockedBy: env.JEVCOMP_PROVIDER ? 'JEVCOMP_PROVIDER' : undefined,
        keys: { openrouter: keyStatus('openrouter', env), typesafe: keyStatus('typesafe', env) },
        lastJev: lastJev ? { at: lastJev.at, ok: lastJev.status !== 'failed', detail: lastJev.status === 'failed' ? lastJev.detail : undefined } : null,
        version: VERSION,
        lastAgent: history.length ? history[history.length - 1].host ?? 'codex' : null,
        agents: {
            codex: codexInstalled ? { lastRun: [...history].reverse().find((row) => row.host === 'codex' || !row.host)?.at ?? null } : null,
            claude: claude ? { ...claude, lastRun: [...history].reverse().find((row) => row.host === 'claude')?.at ?? null } : null,
            agy: { installed: agyInstalled },
        },
        dashboardUrl: `http://127.0.0.1:${dashboardPort(env)}/`,
        measurement,
        settings: SETTINGS_ITEMS.map((item) => ({
            name: item.name,
            value: settingValue[item.name],
            choices: item.choices.map((choice) => choice.value),
            lockedBy: settingOverride(item.name, env),
        })),
    };
}
function provider(value) {
    if (value === 'openrouter' || value === 'typesafe')
        return value;
    throw new Error('provider must be openrouter or typesafe');
}
/** Applies one change sent by the settings page. */
export async function applySettingsChange(body, env, agent) {
    if (body.action === 'setting') {
        const name = body.name;
        if (!SETTINGS_ITEMS.some((item) => item.name === name))
            throw new Error(`unknown setting: ${String(body.name)}`);
        const lockedBy = settingOverride(name, env);
        if (lockedBy)
            throw new Error(`${lockedBy} decides this value`);
        await setUserSetting(name, String(body.value), env, agent);
    }
    else if (body.action === 'reset') {
        await resetUserSettings(env, agent);
    }
    else if (body.action === 'provider') {
        const target = provider(body.provider);
        if (keyStatus(target, env).source === 'none')
            throw new Error('enter a key for this provider first');
        await savePreferredProvider(target, env);
    }
    else if (body.action === 'key') {
        const key = typeof body.key === 'string' ? body.key.trim() : '';
        if (!key)
            throw new Error('the key is empty');
        await saveProviderConfiguration(provider(body.provider), key, env);
    }
    else if (body.action === 'measure') {
        if (typeof body.enabled !== 'boolean')
            throw new Error('enabled must be a boolean');
        if (body.enabled)
            await startExperiment(env, agent);
        else
            await stopExperiment(env, agent);
    }
    else {
        throw new Error('unknown action');
    }
}
