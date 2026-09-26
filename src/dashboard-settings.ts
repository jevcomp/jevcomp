import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dashboardPort } from './dashboard-service.js';
import { inspectHooks } from './install.js';
import { enabledPluginRoot } from './plugin-installation.js';
import { keyStatus, resolveProvider, savePreferredProvider, saveProviderConfiguration, type KeyStatus } from './provider.js';
import { SETTINGS_ITEMS } from './settings-menu.js';
import { resetUserSettings, setUserSetting, settingOverride, userSettings, type SettingName } from './settings.js';
import { readHistory, readHookActivity, type HookActivity } from './store.js';
import { VERSION } from './version.js';
import { agyCaInstalled, agyCertificateThumbprint } from './agy-proxy.js';

type Env = Record<string, string | undefined>;
type Provider = 'openrouter' | 'typesafe';

export interface SettingsSnapshot {
  provider: Provider;
  providerLockedBy?: string;
  keys: Record<Provider, KeyStatus>;
  lastJev: { at: string; ok: boolean; detail?: string } | null;
  version: string;
  lastAgent: 'codex' | 'claude' | 'agy' | null;
  agents: {
    codex: { kind: 'plugin' | 'command'; hooks: { installed: number; total: number; activity: HookActivity } } | null;
    claude: { functionHooks: boolean; lastRun: string | null } | null;
    agy: { installed: boolean };
  };
  dashboardUrl: string;
  settings: Array<{ name: SettingName; value: string; choices: string[]; lockedBy?: string }>;
}

const agyDetection = new Map<string, { at: number; installed: boolean }>();
async function antigravityInstalled(env: Env): Promise<boolean> {
  const key = env.JEVCOMP_AGY_HOME ?? join(homedir(), '.jevcomp', 'agy-ca');
  const cached = agyDetection.get(key);
  if (cached && Date.now() - cached.at < 60_000) return cached.installed;
  const thumbprint = await agyCertificateThumbprint(env);
  const installed = thumbprint ? agyCaInstalled(thumbprint) : false;
  agyDetection.set(key, { at: Date.now(), installed });
  return installed;
}

async function pluginHookCount(pluginRoot: string): Promise<number> {
  // Versions before Claude Code support kept the Codex hooks in hooks.json.
  for (const file of ['codex.json', 'hooks.json']) {
    try {
      const manifest = JSON.parse(await readFile(join(pluginRoot, 'hooks', file), 'utf8'));
      return Object.keys(manifest.hooks ?? {}).length;
    } catch {}
  }
  return 0;
}

async function readJson(path: string): Promise<Record<string, any>> {
  try { return JSON.parse(await readFile(path, 'utf8')) ?? {}; } catch { return {}; }
}

async function claudeInstallation(env: Env): Promise<{ functionHooks: boolean } | null> {
  const home = env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const installed = (await readJson(join(home, 'plugins', 'installed_plugins.json'))).plugins ?? {};
  const settings = await readJson(join(home, 'settings.json'));
  const ids = Object.keys(installed).filter((id) => id.startsWith('jevcomp@') && settings.enabledPlugins?.[id] !== false);
  return ids.length ? { functionHooks: settings.env?.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS === '1' } : null;
}

export async function settingsSnapshot(env: Env = process.env): Promise<SettingsSnapshot> {
  const settings = userSettings(env);
  const pluginRoot = enabledPluginRoot(env);
  const history = await readHistory(env);
  const codexHooks = pluginRoot ? await pluginHookCount(pluginRoot) : (await inspectHooks(env)).events.length;
  const claude = await claudeInstallation(env);
  const agyInstalled = await antigravityInstalled(env);
  const lastJev = [...history].reverse().find((row) => row.phase === 'precompact' || (!row.phase && row.status === 'failed'));
  const settingValue: Record<SettingName, string> = {
    'restore-mode': settings.restoreMode,
    'restore-max-chars': String(settings.restoreMaxChars),
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
    lastAgent: history.length ? history[history.length - 1]!.host ?? 'codex' : null,
    agents: {
      codex: codexHooks ? { kind: pluginRoot ? 'plugin' : 'command', hooks: { installed: codexHooks, total: 4, activity: await readHookActivity(env) } } : null,
      claude: claude ? { ...claude, lastRun: [...history].reverse().find((row) => row.host === 'claude')?.at ?? null } : null,
      agy: { installed: agyInstalled },
    },
    dashboardUrl: `http://127.0.0.1:${dashboardPort(env)}/`,
    settings: SETTINGS_ITEMS.map((item) => ({
      name: item.name,
      value: settingValue[item.name],
      choices: item.choices.map((choice) => choice.value),
      lockedBy: settingOverride(item.name, env),
    })),
  };
}

function provider(value: unknown): Provider {
  if (value === 'openrouter' || value === 'typesafe') return value;
  throw new Error('provider must be openrouter or typesafe');
}

/** Applies one change sent by the settings page. */
export async function applySettingsChange(body: Record<string, unknown>, env: Env = process.env): Promise<void> {
  if (body.action === 'setting') {
    const name = body.name as SettingName;
    if (!SETTINGS_ITEMS.some((item) => item.name === name)) throw new Error(`unknown setting: ${String(body.name)}`);
    const lockedBy = settingOverride(name, env);
    if (lockedBy) throw new Error(`${lockedBy} decides this value`);
    await setUserSetting(name, String(body.value), env);
  } else if (body.action === 'reset') {
    await resetUserSettings(env);
  } else if (body.action === 'provider') {
    const target = provider(body.provider);
    if (keyStatus(target, env).source === 'none') throw new Error('enter a key for this provider first');
    await savePreferredProvider(target, env);
  } else if (body.action === 'key') {
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!key) throw new Error('the key is empty');
    await saveProviderConfiguration(provider(body.provider), key, env);
  } else {
    throw new Error('unknown action');
  }
}
