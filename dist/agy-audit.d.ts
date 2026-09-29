import type { Env } from './provider.js';
import type { Message } from './types.js';
interface SessionJournal {
    seen: Set<string>;
    touchedAt: number;
}
export interface AgyAuditJournalState {
    sessions: Map<string, SessionJournal>;
}
export declare function createAgyAuditJournalState(): AgyAuditJournalState;
export declare function appendAgyOutbound(env: Env, state: AgyAuditJournalState, sessionId: string, messages: readonly Message[], auditId?: string): Promise<void>;
export {};
