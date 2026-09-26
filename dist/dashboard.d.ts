import { type HistoryRow } from './store.js';
interface ToolSummary {
    tool: string;
    calls: number;
    kept: number;
    dropped: number;
    truncated: number;
    originalChars: number;
    removedChars: number;
}
interface RunSummary {
    runId: string;
    at: string;
    sessionId: string;
    trigger?: string;
    model?: string;
    provider?: string;
    host: 'codex' | 'claude' | 'agy';
    status: 'prepared' | 'ready' | 'restored' | 'nothing_missing' | 'skipped' | 'too_short' | 'failed' | 'restore_failed';
    reductionRatio: number;
    charsBefore: number;
    charsAfter: number;
    removedChars: number;
    calls: number;
    kept: number;
    truncated: number;
    dropped: number;
    pinned: number;
    jevRequests: number;
    jevInputTokens: number;
    jevOutputTokens: number;
    jevUsageReportedRequests: number;
    selectionMs: number;
    restoreMode?: string;
    injectedPayloadChars?: number;
    retainedChars?: number;
    nativePresentChars?: number;
    restoreCandidateChars?: number;
    membershipStatus?: string;
    detail?: string;
}
/** Blocks keep transcript order, oldest first, so the chart reads left to right like the conversation. */
interface LastCompaction {
    at: string;
    host: 'codex' | 'claude' | 'agy';
    status: RunSummary['status'];
    charsBefore: number;
    injectedPayloadChars: number;
    blocks: {
        tool: string;
        label: string;
        decision: DecisionCode;
        chars: number;
    }[];
}
type DecisionCode = 'k' | 's' | 'r' | 'p';
/** Build only measured statistics. No chars/4 or claimed Codex billing-token savings. */
export declare function stats(env?: Record<string, string | undefined>, agent?: 'codex' | 'claude' | 'agy'): Promise<{
    measured: boolean;
    note: string;
    attempts: number;
    prepared: number;
    ready: number;
    restored: number;
    latestRestoredAt: string;
    skipped: number;
    nativeFallbacks: number;
    restoreFailures: number;
    transcriptCharsBefore: number;
    transcriptCharsAfter: number;
    transcriptCharsRemoved: number;
    transcriptReductionRatio: number;
    completedCharsBefore: number;
    completedCharsAfter: number;
    completedCharsRemoved: number;
    completedReductionRatio: number;
    retainedArchiveChars: number;
    injectedChars: number;
    injectedPayloadChars: number;
    restoreEligibleChars: number;
    restoreCharsNotInjected: number;
    nativePresentChars: number;
    restoreCandidateChars: number;
    verifiedMemberships: number;
    jevInputTokens: number;
    jevOutputTokens: number;
    jevRequests: number;
    jevUsageReportedRequests: number;
    jevUsageCoverage: number;
    evaluatedSelections: number;
    averageSelectionMs: number;
    settings: import("./settings.js").UserSettings;
    byTool: ToolSummary[];
    recentDecisions: {
        at: string;
        sessionId: string;
        tool: string;
        inputPreview: string;
        action: import("./types.js").DecisionAction;
        removedChars: number;
        originalChars: number;
        dropLoss: number;
        truncateLoss: number;
        pinned: boolean;
        decision: DecisionCode;
        label: string;
        kind: string;
    }[];
    runs: RunSummary[];
    runStatusCounts: Partial<Record<"prepared" | "ready" | "restored" | "skipped" | "failed" | "nothing_missing" | "too_short" | "restore_failed", number>>;
    lastCompaction: LastCompaction | null;
    recentEvents: HistoryRow[];
}>;
export declare function startDashboard(port?: number, env?: Record<string, string | undefined>): Promise<{
    server: any;
    url: string;
}>;
export {};
