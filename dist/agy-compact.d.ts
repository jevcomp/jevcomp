import { type CompactOptions } from './compact.js';
import type { CallDecision, CompactStats, JevAsker } from './types.js';
type RecordValue = Record<string, unknown>;
type PlanAction = CallDecision['action'];
interface SessionPlan {
    goalKey: string;
    actions: Map<string, PlanAction>;
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
    planUpdated: boolean;
    sessionId: string;
    stats: CompactStats;
    decisions: CallDecision[];
    reductionRatio: number;
}
export interface AgyCompactOptions extends CompactOptions {
    minReductionRatio?: number;
    minEligibleChars?: number;
}
export declare function createAgyCompactionState(): AgyCompactionState;
export declare function compactAgyPayload(input: unknown, asker: JevAsker, state: AgyCompactionState, options?: AgyCompactOptions): Promise<AgyCompactResult | undefined>;
export declare function compactAgyRequest(body: Uint8Array, env: Record<string, string | undefined>, state: AgyCompactionState): Promise<AgyCompactResult | undefined>;
export {};
