import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';
export type JevProvider = 'auto' | 'typesafe' | 'openrouter';
export type Env = Record<string, string | undefined>;
export interface JevClientOptions {
    auditObserver?: (event: string, value: unknown) => void;
    provider?: JevProvider;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    timeoutMs?: number;
    retries?: number;
    fetch?: typeof fetch;
    env?: Env;
    /** Cache serialization only when callers keep Jev state objects immutable between asks. */
    cacheStateSerialization?: boolean;
}
export declare function configDir(env?: Env): string;
export declare function defaultKeyPath(provider: Exclude<JevProvider, 'auto'>, env?: Env): string;
export declare function providerPreferencePath(env?: Env): string;
export declare function saveProviderConfiguration(provider: Exclude<JevProvider, 'auto'>, apiKey: string, env?: Env): Promise<{
    keyFile: string;
    providerFile: string;
}>;
/** Saves only the preferred provider, for switching to one whose key is already available. */
export declare function savePreferredProvider(provider: Exclude<JevProvider, 'auto'>, env?: Env): Promise<void>;
export interface KeyStatus {
    source: 'environment' | 'saved' | 'none';
    variable?: string;
    ending?: string;
}
/** Says where the key for a provider comes from, showing only its last four characters. */
export declare function keyStatus(provider: Exclude<JevProvider, 'auto'>, env?: Env): KeyStatus;
export declare function hasSavedProviderKey(provider: Exclude<JevProvider, 'auto'>, env?: Env): boolean;
export declare function resolveApiKey(provider: Exclude<JevProvider, 'auto'>, options?: Pick<JevClientOptions, 'apiKey' | 'env'>): string;
export declare function resolveProvider(options?: Pick<JevClientOptions, 'provider' | 'env' | 'apiKey'>): Exclude<JevProvider, 'auto'>;
export declare function providerConfig(options?: JevClientOptions): {
    provider: Exclude<JevProvider, 'auto'>;
    apiKey: string;
    model: string;
    baseUrl: string;
};
export declare class JevClient implements JevAsker {
    private readonly options;
    private resolved?;
    private readonly serializedStates;
    constructor(options?: JevClientOptions);
    private config;
    private body;
    ask(state: JevState, questions: JevQuestions, signal?: AbortSignal): Promise<JevResponse>;
}
export declare function noul(answers: JevResponse['answers'], key: string): number;
