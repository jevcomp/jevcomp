import { type AuditCapture } from './audit.js';
import { type CompactOptions } from './compact.js';
import type { CallDecision, CompactStats, JevAsker, Message } from './types.js';
type RecordValue = Record<string, unknown>;
type PlanAction = CallDecision['action'];
interface SessionPlan {
    contextKey: string;
    actions: Map<string, PlanAction>;
    origins: Map<string, string>;
    touchedAt: number;
}
export interface AgyCompactionState {
    sessions: Map<string, SessionPlan>;
}
export interface AgyCompactResult {
    payload: RecordValue;
    changed: boolean;
    providerAsked: boolean;
    providerFailed: boolean;
    providerError?: string;
    planUpdated: boolean;
    sessionId: string;
    stats: CompactStats;
    decisions: CallDecision[];
    reductionRatio: number;
    modelMessages: Message[];
    reusedDecisions: {
        callId: string;
        stableKey: string;
        originAuditId?: string;
    }[];
    audit?: AuditCapture;
}
export interface AgyAuditStartContext {
    sessionId: string;
    messages: Message[];
    evaluated: {
        callId: string;
        stableKey: string;
    }[];
    reused: {
        callId: string;
        stableKey: string;
        originAuditId?: string;
    }[];
    stableKeys: Record<string, string>;
    wireBeforeChars: number;
    wireFixedChars: number;
}
export interface AgyCompactOptions extends CompactOptions {
    minReductionRatio?: number;
    minEligibleChars?: number;
    onProviderStart?: (context: AgyAuditStartContext) => Promise<string | undefined>;
}
export declare function createAgyCompactionState(): AgyCompactionState;
export declare function agyPayloadView(input: unknown): {
    sessionId: string;
    messages: Message[];
} | undefined;
export declare function compactAgyPayload(input: unknown, asker: JevAsker, state: AgyCompactionState, options?: AgyCompactOptions): Promise<AgyCompactResult | undefined>;
export declare function compactAgyRequest(body: Uint8Array, env: Record<string, string | undefined>, state: AgyCompactionState): Promise<AgyCompactResult | undefined>;
export {};
