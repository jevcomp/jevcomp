import type { Message } from './types.js';

// Shapes of Claude Code's function-hook `session.compact` messages. This file runs inside Claude Code: no Node imports.
export interface ClaudeToolUse { tool_use_id: string; tool: string; input: Record<string, unknown>; text?: string; isError?: true; result?: unknown }
export interface ClaudeToolResult { tool_use_id: string; text: string; isError: boolean; result?: unknown }
export interface ClaudeMessage { role: 'user' | 'assistant'; text: string; toolUses: ClaudeToolUse[]; toolResults?: ClaudeToolResult[]; handle?: string }
export interface JevCut { dropped: readonly string[]; truncated: Readonly<Record<string, string>> }

export function toJevMessages(messages: readonly ClaudeMessage[]): Message[] {
  return messages.map((message) => ({
    role: message.role,
    text: message.text,
    toolCalls: message.toolUses.map((use) => ({ id: use.tool_use_id, name: use.tool, input: use.input })),
    ...(message.toolResults?.length ? { toolResults: message.toolResults.map((result) => ({ callId: result.tool_use_id, output: result.text, isError: result.isError })) } : {}),
  }));
}

function valueChars(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value === 'string') return value.length;
  try { return JSON.stringify(value).length; } catch { return 0; }
}

/** Content-bearing characters in the actual Claude hook messages, excluding internal handles and object-key overhead. */
export function claudeMessageChars(messages: readonly ClaudeMessage[]): number {
  return messages.reduce((sum, message) => sum
    + message.text.length
    + message.toolUses.reduce((n, use) => n + valueChars(use.input) + valueChars(use.text) + valueChars(use.result), 0)
    + (message.toolResults ?? []).reduce((n, result) => n + result.text.length + valueChars(result.result), 0), 0);
}

/** Messages Jev left alone go back as the engine's own objects; edited ones are rebuilt without the engine's handle. */
export function applyJevCut(messages: readonly ClaudeMessage[], cut: JevCut): ClaudeMessage[] {
  const dropped = new Set(cut.dropped);
  const out: ClaudeMessage[] = [];
  for (const message of messages) {
    const toolUses = message.toolUses
      .filter((use) => !dropped.has(use.tool_use_id))
      .map((use) => {
        if (!(use.tool_use_id in cut.truncated)) return use;
        const { result: _result, ...rest } = use;
        return { ...rest, text: cut.truncated[use.tool_use_id] };
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => !dropped.has(result.tool_use_id))
      .map((result) => (result.tool_use_id in cut.truncated ? { tool_use_id: result.tool_use_id, text: cut.truncated[result.tool_use_id]!, isError: result.isError } : result));
    const changed = toolUses.length !== message.toolUses.length || toolResults.length !== (message.toolResults?.length ?? 0) ||
      toolUses.some((use, i) => use !== message.toolUses[i]) || toolResults.some((result, i) => result !== message.toolResults?.[i]);
    if (!changed) { out.push(message); continue; }
    if (!message.text.trim() && !toolUses.length && !toolResults.length) continue;
    out.push({ role: message.role, text: message.text, toolUses, ...(toolResults.length ? { toolResults } : {}) });
  }
  return out;
}
