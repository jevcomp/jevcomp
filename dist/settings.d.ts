import { type Env } from './provider.js';
export type SettingsAgent = 'codex' | 'claude' | 'agy';
export type SettingName = 'pin-recent-messages' | 'loss-threshold' | 'min-reduction-ratio';
export interface UserSettings {
    pinRecentMessages: number;
    lossThreshold: number;
    minReductionRatio: number;
}
export declare function settingsPath(env?: Env): string;
/** Names the environment variable that wins over the saved value, if any. */
export declare function settingOverride(name: SettingName, env?: Env): string | undefined;
export declare function userSettings(env: Env, agent: SettingsAgent): UserSettings;
export declare function setUserSetting(name: SettingName, rawValue: string, env: Env, agent: SettingsAgent): Promise<UserSettings>;
export declare function resetUserSettings(env: Env, agent: SettingsAgent): Promise<void>;
