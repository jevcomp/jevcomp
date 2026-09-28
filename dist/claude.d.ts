import type { Message } from './types.js';
export interface ClaudeToolUse {
    tool_use_id: string;
    tool: string;
    input: Record<string, unknown>;
    text?: string;
    isError?: true;
    result?: unknown;
}
export interface ClaudeToolResult {
    tool_use_id: string;
    text: string;
    isError: boolean;
    result?: unknown;
}
export interface ClaudeMessage {
    role: 'user' | 'assistant';
    text: string;
    toolUses: ClaudeToolUse[];
    toolResults?: ClaudeToolResult[];
    handle?: string;
}
export interface JevCut {
    dropped: readonly string[];
    truncated: Readonly<Record<string, string>>;
}
export declare function toJevMessages(messages: readonly ClaudeMessage[]): Message[];
/** Serialized Claude hook payload size, excluding internal handles that are not model context. */
export declare function claudeMessageChars(messages: readonly ClaudeMessage[]): number;
/** Refine a requested cut against host fields jevcomp does not understand. */
export declare function safeJevCut(messages: readonly ClaudeMessage[], cut: JevCut): JevCut;
/** Messages Jev left alone go back as the engine's own objects; edited ones are rebuilt without the engine's handle. */
export declare function applyJevCut(messages: readonly ClaudeMessage[], cut: JevCut): ClaudeMessage[];
