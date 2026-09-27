import type { Env } from './provider.js';
import type { Message } from './types.js';
import { type AuditAgent, type AuditMode } from './audit-store.js';
export type AuditObserver = (event: string, value: unknown) => void;
export interface AuditManifest {
    schema: 1;
    id: string;
    agent: AuditAgent;
    sessionId?: string;
    agentId?: string;
    sessionSource: 'native' | 'unknown';
    transcript?: string;
    transcriptOffset?: number;
    startedAt: string;
    endedAt?: string;
    mode: AuditMode;
    version: string;
    build: string;
    policy: 'conservative-prefix-v1';
    stage: 'started' | 'evaluated' | 'result_produced' | 'rejected' | 'failed';
    reason?: string;
    historyRecorded?: boolean;
    settings: Record<string, unknown>;
    hashes: Record<string, string>;
    references: Record<string, string>;
    batches: {
        questionsHash: string;
        responseHash?: string;
        questionsRef?: string;
        responseRef?: string;
    }[];
    attempts: {
        attempt: number;
        status?: number;
        failed?: boolean;
    }[];
    calls: {
        id: string;
        occurrence: number;
        inputHash: string;
        resultHashes: string[];
        resultLengths: number[];
        inputChars: number;
        messageIndex: number;
        isError: boolean;
    }[];
    gaps: string[];
    beginMs: number;
    captureMs: number;
    observedInputHash: string;
    outputHash?: string;
}
export declare function observeAudit(observer: AuditObserver | undefined, event: string, value: unknown): void;
export declare function messageHash(messages: readonly Message[]): string;
export declare class AuditCapture {
    private readonly env;
    private readonly quota;
    private readonly graph;
    private captureTime;
    private closed;
    readonly manifest: AuditManifest;
    constructor(env: Env, quota: number, limit: number, manifest: AuditManifest);
    readonly observe: AuditObserver;
    private gap;
    finish(stage: AuditManifest['stage'], reason: string, historyRecorded: boolean, output?: unknown): Promise<void>;
    private failureMarker;
}
export declare function beginAudit(env: Env, agent: AuditAgent, id: string, messages: readonly Message[], settings: Record<string, unknown>, sessionId?: string, agentId?: string): Promise<AuditCapture | undefined>;
export declare function bindAuditSource(env: Env, agent: AuditAgent, sessionId: string, path: string, agentId?: string): Promise<void>;
export declare function auditEvent(env: Env, id: string, event: 'transport_finished', evidence: string): Promise<void>;
export declare function auditManifests(env: Env): Promise<{
    manifests: AuditManifest[];
    corrupt: string[];
}>;
