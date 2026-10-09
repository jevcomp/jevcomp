import { type SettingsAgent } from './settings.js';
export interface HookOptions {
    startDashboard?: boolean;
}
/** Jev settings shared by the Codex proxy and Claude Code compaction. */
export declare function jevCompactOptions(env: Record<string, string | undefined>, agent: SettingsAgent): {
    provider: "typesafe" | "openrouter";
    env: Record<string, string | undefined>;
    model: string;
    goal: string | undefined;
    baseUrl: string;
    lossThreshold: number;
    preserveRecentMessages: number;
    maxStateTokens: number;
    maxRequestTokens: number;
    truncateHeadChars: number;
    truncateTailChars: number;
    maxConcurrentRequests: number;
    timeoutMs: number;
    retries: number;
};
/** Plugins cannot set environment variables, and Claude Code reads these only at startup, from the user's settings. */
export declare function enableFunctionHooks(env: Record<string, string | undefined>): Promise<string>;
export declare function handleHook(value: unknown, env?: Record<string, string | undefined>, options?: HookOptions): Promise<Record<string, unknown>>;
