import { spawn } from 'node:child_process';
export { isCodexCompactionRequest } from './codex-compaction.js';
type AuthRoute = 'chatgpt' | 'api';
export type Destinations = Record<AuthRoute, string>;
/** Another tool (e.g. a local ChatGPT bridge) may own `openai_base_url`; bypassing it breaks its custom models. */
export declare function codexDestinations(env: Record<string, string | undefined>): Promise<Destinations>;
export declare function startCodexProxy(env?: Record<string, string | undefined>, configuredUpstreams?: Destinations, serverOptions?: {
    port?: number;
    instanceId?: string;
    build?: string;
    config?: string;
}): Promise<{
    baseUrl: string;
    close: () => Promise<void>;
}>;
export declare function codexArguments(baseUrl: string, args: readonly string[]): string[];
export declare function runCodex(args: readonly string[], env?: Record<string, string | undefined>, options?: {
    spawn?: typeof spawn;
    upstreams?: Destinations;
    startProxy?: typeof startCodexProxy;
    startDashboard?: () => Promise<unknown>;
}): Promise<number>;
