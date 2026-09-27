import { type JevClientOptions } from './provider.js';
import type { CompactResult, JevAsker, Message } from './types.js';
import { type AuditObserver } from './audit.js';
export interface CompactOptions {
    auditObserver?: AuditObserver;
    goal?: string;
    /** Preferred name: maximum accepted loss risk for a destructive action. */
    lossThreshold?: number;
    /** @deprecated Use lossThreshold. */
    keepThreshold?: number;
    preserveRecentMessages?: number;
    maxStateTokens?: number;
    maxRequestTokens?: number;
    truncateHeadChars?: number;
    truncateTailChars?: number;
    maxConcurrentRequests?: number;
}
export declare function estimateTokens(text: string): number;
export declare function shortenToolResult(text: string, head: number, tail: number): string;
export declare function shortenedResultLength(originalChars: number, head: number, tail: number): number;
export declare function reductionRatio(r: Pick<CompactResult, 'stats'>): number;
export declare function compact(messages: readonly Message[], asker: JevAsker, input?: CompactOptions): Promise<CompactResult>;
export declare function compactMessages(messages: readonly Message[], opts?: CompactOptions & JevClientOptions): Promise<CompactResult>;
