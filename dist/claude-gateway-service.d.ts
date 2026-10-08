export type ClaudeGatewayEnv = Record<string, string | undefined>;
export interface ClaudeGatewayInstance {
    pid: number;
    instanceId: string;
    url: string;
    upstream: string;
    build: string;
    version?: string;
}
export declare const DEFAULT_CLAUDE_GATEWAY_PORT = 16392;
export declare const CLAUDE_GATEWAY_SERVICE = "jevcomp-claude-gateway";
export declare function claudeGatewayPort(env?: ClaudeGatewayEnv): number;
export declare function claudeGatewayUrl(env?: ClaudeGatewayEnv): string;
export declare function claudeGatewayInstancePath(port: number, env?: ClaudeGatewayEnv): string;
export declare function runningClaudeGateway(port?: number, env?: ClaudeGatewayEnv): Promise<ClaudeGatewayInstance | undefined>;
export declare function stopClaudeGateway(env?: ClaudeGatewayEnv): Promise<void>;
export declare function ensureClaudeGateway(upstream: string, env?: ClaudeGatewayEnv, cliPath?: any): Promise<ClaudeGatewayInstance>;
