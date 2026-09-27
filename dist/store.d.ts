import type { CallDecision, CompactStats } from './types.js';
export interface HistoryRow {
    at: string;
    runId?: string;
    sessionId: string;
    turnId?: string;
    trigger?: string;
    model?: string;
    provider?: string;
    host?: 'codex' | 'claude' | 'agy';
    phase?: 'precompact' | 'postcompact' | 'restore';
    status: 'prepared' | 'ready' | 'restored' | 'skipped' | 'failed';
    stats?: CompactStats;
    decisions?: CallDecision[];
    detail?: string;
    injectedChars?: number;
    injectedPayloadChars?: number;
    retainedChars?: number;
}
/** One folder for every agent, so the Codex and Claude Code plugins share history and the dashboard. */
export declare function dataDir(env?: Record<string, string | undefined>): string;
/** JEVCOMP_CAPTURE=1 saves under ~/.jevcomp; any other value is taken as the folder itself. */
export declare function captureDirectory(env: Record<string, string | undefined>, folder: string): string | undefined;
export declare function historyPath(env?: Record<string, string | undefined>): string;
export declare function readableHistoryPaths(env?: Record<string, string | undefined>): string[];
export declare function appendHistory(row: HistoryRow, env?: Record<string, string | undefined>): Promise<void>;
export declare function tryAppendHistory(row: HistoryRow, env?: Record<string, string | undefined>): Promise<boolean>;
export declare function readHistory(env?: Record<string, string | undefined>): Promise<HistoryRow[]>;
