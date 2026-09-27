import { spawn } from 'node:child_process';
export { isCodexCompactionRequest } from './codex-compaction.js';
type AuthRoute = 'chatgpt' | 'api';
type Destinations = Record<AuthRoute, string>;
export declare function startCodexProxy(env?: Record<string, string | undefined>, upstreams?: Destinations): Promise<{
    baseUrl: string;
    close: () => Promise<void>;
}>;
export declare function codexArguments(baseUrl: string, args: readonly string[]): string[];
export declare function runCodex(args: readonly string[], env?: Record<string, string | undefined>, options?: {
    spawn?: typeof spawn;
    upstreams?: Destinations;
    startDashboard?: () => Promise<unknown>;
}): Promise<number>;
