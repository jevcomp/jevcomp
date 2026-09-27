import { type SettingName, type SettingsAgent, type UserSettings } from './settings.js';
type Env = Record<string, string | undefined>;
interface Choice {
    value: string;
    label: string;
}
interface Item {
    name: SettingName;
    title: string;
    help: string;
    choices: Choice[];
    current: (settings: UserSettings) => string;
}
export declare const SETTINGS_ITEMS: Item[];
export declare function describeSettings(env: Env, agent: SettingsAgent): Array<{
    title: string;
    value: string;
    lockedBy?: string;
}>;
/** Moves one setting to its previous or next choice and saves it. */
export declare function stepSetting(name: SettingName, direction: 1 | -1, env: Env, agent: SettingsAgent): Promise<void>;
interface Terminal {
    input: {
        on(event: 'data', listener: (chunk: any) => void): unknown;
        off(event: 'data', listener: (chunk: any) => void): unknown;
        setRawMode?(mode: boolean): unknown;
        resume(): unknown;
        pause(): unknown;
    };
    output: {
        write(text: string): unknown;
        columns?: number;
    };
}
/** Runs the arrow-key menu until Esc, q or Ctrl+C. */
export declare function runSettingsMenu(terminal: Terminal, env: Env, agent: SettingsAgent): Promise<void>;
export {};
