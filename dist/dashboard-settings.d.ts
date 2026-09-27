import { type KeyStatus } from './provider.js';
import { type SettingName, type SettingsAgent } from './settings.js';
import { type AuditMode } from './audit-store.js';
type Env = Record<string, string | undefined>;
type Provider = 'openrouter' | 'typesafe';
export interface SettingsSnapshot {
    provider: Provider;
    providerLockedBy?: string;
    keys: Record<Provider, KeyStatus>;
    lastJev: {
        at: string;
        ok: boolean;
        detail?: string;
    } | null;
    version: string;
    lastAgent: 'codex' | 'claude' | 'agy' | null;
    agents: {
        codex: {
            lastRun: string | null;
        } | null;
        claude: {
            functionHooks: boolean;
            lastRun: string | null;
        } | null;
        agy: {
            installed: boolean;
        };
    };
    dashboardUrl: string;
    audit: {
        supported: boolean;
        enabled: boolean;
        mode: AuditMode;
    };
    settings: Array<{
        name: SettingName;
        value: string;
        choices: string[];
        lockedBy?: string;
    }>;
}
export declare function settingsSnapshot(env?: Env, agent?: SettingsAgent): Promise<SettingsSnapshot>;
/** Applies one change sent by the settings page. */
export declare function applySettingsChange(body: Record<string, unknown>, env: Env, agent: SettingsAgent): Promise<void>;
export {};
