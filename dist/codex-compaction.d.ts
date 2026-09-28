import type { Message } from './types.js';
export declare function codexTurnMetadata(value: unknown): Record<string, unknown> | undefined;
export declare function isCodexCompactionRequest(value: unknown): boolean;
/**
 * Codex local compaction re-inserts recent user messages outside the summary,
 * up to a 20k-token budget. Only messages fully covered by that budget are
 * safe to omit from jevcomp's synthetic summary; the boundary message stays.
 */
export declare function codexPreservedUserMessages(messages: readonly Message[]): Set<Message>;
export declare function renderCodexCompactionSummary(messages: readonly Message[]): string;
/**
 * Measures the text jevcomp would actually return to Codex, not transcript
 * content that Codex preserves or re-injects outside the summary.
 */
export declare function codexCompactionReductionRatio(before: readonly Message[], after: readonly Message[]): number;
