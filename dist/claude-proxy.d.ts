import { spawn } from 'node:child_process';
type Env = Record<string, string | undefined>;
export interface ClaudeUsageRow {
    at: string;
    model?: string;
    path: string;
    statusCode: number;
    durationMs: number;
    sessionId?: string;
    inputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    outputTokens?: number;
}
export declare function claudeProxyUnsupportedReason(env: Env): string | undefined;
export declare function startClaudeProxy(env?: Env): Promise<{
    baseUrl: string;
    upstream: string;
    close: () => Promise<void>;
}>;
export declare function runClaude(args: readonly string[], env?: Env, options?: {
    spawn?: typeof spawn;
    startProxy?: typeof startClaudeProxy;
    startDashboard?: () => Promise<unknown>;
}): Promise<number>;
export {};
