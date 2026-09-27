import type { Env } from './provider.js';
export type AuditAgent = 'codex' | 'claude';
export type AuditMode = 'metadata' | 'evidence';
export interface AuditConfig {
    schema: 1;
    agents: Partial<Record<AuditAgent, AuditMode>>;
    maxBytes: number;
    retentionDays: number;
    captureBytes: number;
}
export declare const defaultAuditConfig: () => AuditConfig;
export declare const auditRoot: (env: Env) => any;
export declare const digest: (value: string | Uint8Array) => string;
export declare const validId: (id: string) => boolean;
export declare const validHash: (id: string) => boolean;
export declare function readJson<T>(path: string): Promise<T>;
export declare function auditConfig(env: Env): Promise<AuditConfig>;
export declare function atomicJson(path: string, value: unknown): Promise<void>;
export declare function withAuditLock<T>(env: Env, action: () => Promise<T>): Promise<T>;
export declare function directoryBytes(root: string): Promise<number>;
export declare function reserveBytes(env: Env, count: number, limit: number): Promise<void>;
export declare class EvidenceGraph {
    readonly limit: number;
    readonly objects: Map<string, Uint8Array<ArrayBufferLike>>;
    bytes: number;
    private readonly identities;
    constructor(limit: number);
    pack(value: unknown, depth?: number): string;
}
export declare function persistGraph(env: Env, graph: EvidenceGraph, limit: number): Promise<void>;
export declare function unpackEvidence(env: Env, hash: string, maxBytes?: number): Promise<unknown>;
export declare function configureAudit(env: Env, agent: AuditAgent, mode?: AuditMode): Promise<AuditConfig>;
