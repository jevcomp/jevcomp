import type { Env } from './provider.js';
import type { AuditManifest } from './audit.js';
export interface SourceEvent {
    offset: number;
    length: number;
    hash: string;
    at: string;
    kind: string;
    id?: string;
    tool?: string;
    inputHash?: string;
    outputHash?: string;
    chars?: number;
    textHashes?: string[];
    encrypted?: boolean;
}
export interface SourceIndex {
    schema: 1;
    path: string;
    sessionId: string;
    offset: number;
    prefixHash: string;
    events: SourceEvent[];
    gaps: string[];
    updatedAt: string;
}
export declare function resolveTranscript(env: Env, manifest: AuditManifest): Promise<string | undefined>;
export declare function blockText(content: unknown): string;
export declare function indexTranscript(env: Env, manifest: AuditManifest): Promise<SourceIndex | undefined>;
export declare function sourceRecord(index: SourceIndex, event: SourceEvent): Promise<any>;
export declare function sourceLabel(index: SourceIndex): string;
