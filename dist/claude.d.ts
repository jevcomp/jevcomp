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
/** Content-bearing characters in the actual Claude hook messages, excluding internal handles and object-key overhead. */
export declare function claudeMessageChars(messages: readonly ClaudeMessage[]): number;
/** Messages Jev left alone go back as the engine's own objects; edited ones are rebuilt without the engine's handle. */
export declare function applyJevCut(messages: readonly ClaudeMessage[], cut: JevCut): ClaudeMessage[];
