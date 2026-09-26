import type { CallDecision, CompactStats, Message } from './types.js';
export interface SessionState {
    version: 1;
    sessionId: string;
    runId?: string;
    turnId?: string;
    trigger?: string;
    model?: string;
    transcriptPath?: string;
    transcriptBytesAtScore?: number;
    createdAt: string;
    ready: boolean;
    consumed: boolean;
    contextFile: string;
    messagesFile?: string;
    index: string;
    contextChars: number;
    stats: CompactStats;
    decisions: CallDecision[];
}
export interface HistoryRow {
    at: string;
    runId?: string;
    sessionId: string;
    turnId?: string;
    trigger?: string;
    model?: string;
    provider?: string;
    /** Absent on rows written before Claude Code support, which all came from Codex. */
    host?: 'codex' | 'claude' | 'agy';
    phase?: 'precompact' | 'postcompact' | 'restore';
    status: 'prepared' | 'ready' | 'restored' | 'skipped' | 'failed';
    stats?: CompactStats;
    decisions?: CallDecision[];
    detail?: string;
    restoreMode?: 'preserve' | 'balanced' | 'minimal';
    restoreLimitChars?: number;
    injectedChars?: number;
    injectedPayloadChars?: number;
    retainedChars?: number;
    /** Retained normalized characters proven to already exist after native compaction. */
    nativePresentChars?: number;
    /** Retained normalized characters still missing after exact post-compaction membership checks. */
    restoreCandidateChars?: number;
    membershipStatus?: 'verified' | 'unavailable' | 'stale';
    dedupedTextItems?: number;
    dedupedToolPairs?: number;
}
/** One folder for every agent, so the Codex and Claude Code plugins share history and the dashboard. */
export declare function dataDir(env?: Record<string, string | undefined>): string;
/** JEVCOMP_CAPTURE=1 saves under ~/.jevcomp; any other value is taken as the folder itself. */
export declare function captureDirectory(env: Record<string, string | undefined>, folder: string): string | undefined;
export declare function statePath(sessionId: string, env?: Record<string, string | undefined>): string;
export declare function contextPath(sessionId: string, env?: Record<string, string | undefined>): string;
export declare function messagesPath(sessionId: string, env?: Record<string, string | undefined>): string;
export declare function historyPath(env?: Record<string, string | undefined>): string;
export declare function readableHistoryPaths(env?: Record<string, string | undefined>): string[];
export declare function prepareState(state: Omit<SessionState, 'version' | 'ready' | 'consumed' | 'contextFile' | 'contextChars' | 'messagesFile'>, context: string, env?: Record<string, string | undefined>, messages?: readonly Message[]): Promise<SessionState>;
export declare function discardPendingState(sessionId: string, env?: Record<string, string | undefined>): Promise<void>;
export declare function readState(sessionId: string, env?: Record<string, string | undefined>): Promise<SessionState | undefined>;
export declare function peekReady(sessionId: string, ttlMs: number, env?: Record<string, string | undefined>): Promise<SessionState | undefined>;
export declare function markReady(sessionId: string, turnId?: string, env?: Record<string, string | undefined>): Promise<SessionState | undefined>;
export declare function claimReady(sessionId: string, ttlMs: number, env?: Record<string, string | undefined>, expectedCreatedAt?: string): Promise<SessionState | undefined>;
/** Best-effort cleanup of stale per-session sidecars. History is intentionally retained. */
export declare function sweep(env?: Record<string, string | undefined>, maxAgeMs?: number): Promise<number>;
export declare function appendHistory(row: HistoryRow, env?: Record<string, string | undefined>): Promise<void>;
/** History is observability only; hook correctness must never depend on this write succeeding. */
export declare function tryAppendHistory(row: HistoryRow, env?: Record<string, string | undefined>): Promise<boolean>;
export declare function readHistory(env?: Record<string, string | undefined>): Promise<HistoryRow[]>;
export type HookActivity = Partial<Record<'SessionStart' | 'UserPromptSubmit' | 'PreCompact' | 'PostCompact', string>>;
export declare function hookActivityPath(env?: Record<string, string | undefined>): string;
export declare function readHookActivity(env?: Record<string, string | undefined>): Promise<HookActivity>;
/** Remembers when Codex last ran each hook, as proof the hooks are active. */
export declare function recordHookActivity(event: string, env?: Record<string, string | undefined>): Promise<void>;
