type Env = Record<string, string | undefined>;
export type AgentProxyKind = 'codex' | 'agy';
export interface AgentProxyInstance {
    pid: number;
    instanceId: string;
    url: string;
    build: string;
    config: string;
    version?: string;
}
export declare function agentProxyPort(kind: AgentProxyKind, env?: Env): number;
export declare function agentProxyUrl(kind: AgentProxyKind, env?: Env): string;
export declare function runningAgentProxy(kind: AgentProxyKind, env?: Env): Promise<AgentProxyInstance | undefined>;
export declare function stopAgentProxy(kind: AgentProxyKind, env?: Env): Promise<void>;
export declare function ensureAgentProxy(kind: AgentProxyKind, config: string, env?: Env, cliPath?: any): Promise<AgentProxyInstance>;
export {};
