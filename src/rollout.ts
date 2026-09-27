import { open } from 'node:fs/promises';
import type { Message, Role, ToolCall, ToolResult } from './types.js';

const CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'tool_search_call', 'web_search_call']);
const OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output', 'tool_search_output', 'web_search_call_output']);
const KNOWN_IGNORED_RESPONSE_TYPES = new Set(['additional_tools', 'reasoning', 'compaction', 'configuration_update', 'compaction_trigger', 'context_compaction', 'other']);
const KNOWN_IGNORED_ROLLOUT_TYPES = new Set(['session_meta', 'inter_agent_communication_metadata', 'turn_context', 'token_usage_record', 'world_state', 'retained_context', 'security_risk_score', 'event_msg']);

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const text = value.flatMap((item) => record(item) && typeof item.text === 'string' ? [item.text] : []).join('\n');
    if (text) return text;
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  if (record(value)) {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return '';
}

const UNJUDGABLE_CONTENT_TYPES = new Set(['input_image', 'input_audio', 'encrypted_content']);

function hasUnjudgableContent(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((item) => record(item) && (
    (typeof item.type === 'string' && UNJUDGABLE_CONTENT_TYPES.has(item.type)) ||
    (typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0)
  ));
}

function callInput(item: Record<string, unknown>): unknown {
  const raw = item.arguments ?? item.input ?? item.action ?? {};
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

function isCall(item: Record<string, unknown>): boolean {
  const type = typeof item.type === 'string' ? item.type : '';
  return CALL_TYPES.has(type) || (type.endsWith('_call') && !type.endsWith('_output') && typeof (item.call_id ?? item.id) === 'string');
}

function isOutput(item: Record<string, unknown>): boolean {
  const type = typeof item.type === 'string' ? item.type : '';
  return OUTPUT_TYPES.has(type) || (type.endsWith('_output') && typeof (item.call_id ?? item.id) === 'string');
}

function pushCall(messages: Message[], call: ToolCall): void {
  const last = messages.at(-1);
  if (last?.role === 'assistant') last.toolCalls.push(call);
  else messages.push({ role: 'assistant', text: '', toolCalls: [call] });
}

function pushResult(messages: Message[], result: ToolResult): void {
  const last = messages.at(-1);
  if (last?.role === 'user' && !last.text && last.toolResults) last.toolResults.push(result);
  else messages.push({ role: 'user', text: '', toolCalls: [], toolResults: [result] });
}

export function appendResponseItem(messages: Message[], value: unknown): void {
  if (!record(value)) return;
  const type = typeof value.type === 'string' ? value.type : '';
  if (type === 'message' || type === 'agent_message') {
    const roleValue = type === 'agent_message' ? 'assistant' : value.role;
    const rawRole: Role = roleValue === 'system' || roleValue === 'developer' || roleValue === 'user' || roleValue === 'assistant' || roleValue === 'tool'
      ? roleValue
      : 'unknown';
    if (type === 'agent_message' && hasUnjudgableContent(value.content)) {
      throw new UnsupportedCodexRolloutError('encrypted agent message cannot be judged by Jev');
    }
    if (type === 'message' && hasUnjudgableContent(value.content)) {
      throw new UnsupportedCodexRolloutError('non-text Codex message content cannot be judged by Jev');
    }
    const text = textOf(value.content ?? value.message);
    if (text) messages.push({ role: rawRole, text, toolCalls: [] });
    return;
  }
  if (type === 'image_generation_call') {
    throw new UnsupportedCodexRolloutError('image generation context cannot be judged by text-only Jev');
  }
  if (isCall(value)) {
    if (Array.isArray(value.encrypted_function_args) && value.encrypted_function_args.length > 0) {
      throw new UnsupportedCodexRolloutError('encrypted tool arguments cannot be judged by Jev');
    }
    const id = value.call_id ?? value.id;
    if (typeof id !== 'string' || !id) return;
    pushCall(messages, { id, name: typeof value.name === 'string' ? value.name : type || 'tool', input: callInput(value) });
    return;
  }
  if (isOutput(value)) {
    const id = value.call_id ?? value.id;
    if (typeof id !== 'string' || !id) return;
    const rawOutput = value.output ?? value.result ?? value.content ?? value.tools ?? value;
    if (hasUnjudgableContent(rawOutput)) throw new UnsupportedCodexRolloutError('non-text tool output cannot be judged by Jev');
    const status = typeof value.status === 'string' ? value.status : '';
    pushResult(messages, {
      callId: id,
      output: textOf(rawOutput),
      isError: value.is_error === true || status === 'failed' || status === 'error',
    });
    return;
  }
  if (KNOWN_IGNORED_RESPONSE_TYPES.has(type)) return;
  if (type) throw new UnsupportedCodexRolloutError(`unknown Codex response item type: ${type}`);
}

function payload(row: Record<string, unknown>): Record<string, unknown> | undefined {
  return record(row.payload) ? row.payload : undefined;
}

function isRollback(row: Record<string, unknown>): boolean {
  if (row.type !== 'event_msg') return false;
  const body = payload(row);
  return body?.type === 'thread_rolled_back';
}

function replacementHistory(row: Record<string, unknown>): unknown[] | undefined {
  if (row.type !== 'compacted') return undefined;
  const replacement = payload(row)?.replacement_history;
  return Array.isArray(replacement) && replacement.length ? replacement : undefined;
}

function hasModernWindow(row: Record<string, unknown>): boolean {
  const body = payload(row);
  return typeof body?.window_number === 'number' || typeof body?.window_id === 'number';
}

function isBoundedCheckpoint(row: Record<string, unknown>): boolean {
  return !!replacementHistory(row) && hasModernWindow(row);
}

function applyLegacyCompaction(messages: Message[], row: Record<string, unknown>): void {
  const body = payload(row);
  const summary = typeof body?.message === 'string' ? body.message : '';
  const protectedMessages = messages.filter((message) =>
    (message.role === 'user' || message.role === 'developer' || message.role === 'system') &&
    message.text.trim() && !(message.toolResults?.length));
  messages.length = 0;
  messages.push(...protectedMessages);
  if (summary) messages.push({ role: 'assistant', text: summary, toolCalls: [] });
}

export class UnsupportedCodexRolloutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedCodexRolloutError';
  }
}

interface CodexRolloutSnapshot {
  messages: Message[];
}

function applyRolloutRow(messages: Message[], row: Record<string, unknown>): void {
  if (isRollback(row)) throw new UnsupportedCodexRolloutError('legacy Codex rollback requires native compaction');
  if (row.type === 'compacted') {
    const replacement = replacementHistory(row);
    if (replacement) {
      messages.length = 0;
      for (const item of replacement) appendResponseItem(messages, item);
    } else {
      if (hasModernWindow(row) || typeof payload(row)?.message !== 'string') {
        throw new UnsupportedCodexRolloutError('compaction checkpoint is missing history');
      }
      applyLegacyCompaction(messages, row);
    }
    return;
  }
  if (row.type === 'inter_agent_communication') {
    const communication = payload(row);
    const content = communication?.content;
    if (typeof communication?.encrypted_content === 'string' && communication.encrypted_content) {
      throw new UnsupportedCodexRolloutError('encrypted inter-agent context cannot be judged by Jev');
    }
    if (typeof content === 'string' && content) {
      appendResponseItem(messages, {
        type: 'agent_message',
        author: communication?.author,
        recipient: communication?.recipient,
        content: [{ text: content }],
      });
    }
    return;
  }
  if (row.type === 'response_item') { appendResponseItem(messages, row.payload); return; }
  if (row.type === 'realtime_item') throw new UnsupportedCodexRolloutError('realtime Codex history cannot be judged by text-only Jev');
  if (typeof row.type === 'string' && !KNOWN_IGNORED_ROLLOUT_TYPES.has(row.type)) {
    throw new UnsupportedCodexRolloutError(`unknown Codex rollout item type: ${row.type}`);
  }
}

export function parseCodexRollout(jsonl: string): Message[] {
  const messages: Message[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); }
    catch { throw new UnsupportedCodexRolloutError('malformed Codex rollout JSONL'); }
    if (!record(row)) throw new UnsupportedCodexRolloutError('invalid Codex rollout JSONL row');
    applyRolloutRow(messages, row);
  }
  return messages;
}

function parseRow(bytes: any): Record<string, unknown> | undefined {
  const line = bytes.toString('utf8').trim();
  if (!line) return undefined;
  let row: unknown;
  try { row = JSON.parse(line); }
  catch { throw new UnsupportedCodexRolloutError('malformed Codex rollout JSONL'); }
  if (!record(row)) throw new UnsupportedCodexRolloutError('invalid Codex rollout JSONL row');
  return row;
}

function inspectRow(bytes: any, offset: number, unsafeNewerHistory: boolean): { checkpoint?: number; unsafe: boolean } {
  const row = parseRow(bytes);
  if (!row) return { unsafe: unsafeNewerHistory };
  if (isRollback(row)) unsafeNewerHistory = true;
  if (row.type === 'compacted') {
    if (!isBoundedCheckpoint(row)) unsafeNewerHistory = true;
    else if (!unsafeNewerHistory) return { checkpoint: offset, unsafe: false };
  }
  return { unsafe: unsafeNewerHistory };
}

async function readRange(file: Awaited<ReturnType<typeof open>>, start: number, length: number): Promise<any> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await file.read(buffer, offset, length - offset, start + offset);
    if (!result.bytesRead) break;
    offset += result.bytesRead;
  }
  return offset === length ? buffer : buffer.subarray(0, offset);
}

async function parseForwardRange(file: Awaited<ReturnType<typeof open>>, start: number, end: number, chunkBytes: number): Promise<Message[]> {
  const messages: Message[] = [];
  let position = start;
  let pending: any[] = [];
  let pendingBytes = 0;
  const consume = (bytes: any): void => {
    const row = parseRow(bytes);
    if (row) applyRolloutRow(messages, row);
  };

  while (position < end) {
    const length = Math.min(Math.max(1, chunkBytes), end - position);
    const chunk = await readRange(file, position, length);
    if (!chunk.length) break;
    let left = 0;
    while (left < chunk.length) {
      const newline = chunk.indexOf(0x0a, left);
      if (newline < 0) break;
      const part = chunk.subarray(left, newline);
      if (pending.length) {
        consume(Buffer.concat([...pending, part], pendingBytes + part.length));
        pending = [];
        pendingBytes = 0;
      } else consume(part);
      left = newline + 1;
    }
    if (left < chunk.length) {
      const part = chunk.subarray(left);
      pending.push(part);
      pendingBytes += part.length;
    }
    position += chunk.length;
  }
  if (position < end) throw new UnsupportedCodexRolloutError('Codex rollout changed while reading');
  if (pending.length) consume(pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes));
  return messages;
}

/**
 * Finds the newest safe modern compaction checkpoint without repeatedly copying
 * a giant JSONL record that crosses many read chunks. A crossing line is kept
 * as buffer fragments and concatenated only once, when its leading newline is found.
 */
async function loadCodexRolloutSnapshot(path: string, chunkBytes = 1024 * 1024): Promise<CodexRolloutSnapshot> {
  const file = await open(path, 'r');
  try {
    const size = Number((await file.stat()).size);
    let end = size;
    let unsafeNewerHistory = false;
    let checkpoint: number | undefined;
    let pending: any[] = [];
    let pendingBytes = 0;
    let rightBoundaryEndsLine = true;

    const inspect = (bytes: any, offset: number): boolean => {
      if (!bytes.length || checkpoint !== undefined || unsafeNewerHistory) return checkpoint !== undefined || unsafeNewerHistory;
      const result = inspectRow(bytes, offset, unsafeNewerHistory);
      checkpoint = result.checkpoint;
      unsafeNewerHistory = result.unsafe;
      return checkpoint !== undefined || unsafeNewerHistory;
    };

    while (end > 0 && checkpoint === undefined && !unsafeNewerHistory) {
      const start = Math.max(0, end - Math.max(1, chunkBytes));
      const chunk = await readRange(file, start, end - start);
      let right = chunk.length;
      let newline = chunk.lastIndexOf(0x0a, right - 1);

      if (pending.length) {
        if (newline < 0) {
          if (start === 0) {
            const line = Buffer.concat([chunk, ...pending], chunk.length + pendingBytes);
            inspect(line, 0);
            pending = [];
            pendingBytes = 0;
          } else {
            pending.unshift(chunk);
            pendingBytes += chunk.length;
          }
          end = start;
          continue;
        }
        const prefix = chunk.subarray(newline + 1, right);
        const line = Buffer.concat([prefix, ...pending], prefix.length + pendingBytes);
        if (inspect(line, start + newline + 1)) break;
        pending = [];
        pendingBytes = 0;
        right = newline;
      } else if (rightBoundaryEndsLine) {
        if (newline < 0) {
          if (start === 0) inspect(chunk, 0);
          else {
            pending = [chunk];
            pendingBytes = chunk.length;
            rightBoundaryEndsLine = false;
          }
          end = start;
          continue;
        }
        const suffix = chunk.subarray(newline + 1, right);
        if (suffix.length && inspect(suffix, start + newline + 1)) break;
        right = newline;
      }

      while (right > 0 && checkpoint === undefined && !unsafeNewerHistory) {
        const previous = chunk.lastIndexOf(0x0a, right - 1);
        if (previous < 0) break;
        if (inspect(chunk.subarray(previous + 1, right), start + previous + 1)) break;
        right = previous;
      }
      if (checkpoint !== undefined || unsafeNewerHistory) break;

      if (start === 0) {
        if (right > 0) inspect(chunk.subarray(0, right), 0);
      } else if (right > 0) {
        pending = [chunk.subarray(0, right)];
        pendingBytes = right;
        rightBoundaryEndsLine = false;
      } else {
        rightBoundaryEndsLine = true;
      }
      end = start;
    }

    const from = checkpoint ?? 0;
    return {
      messages: await parseForwardRange(file, from, size, chunkBytes),
    };
  } finally {
    await file.close();
  }
}

export async function loadCodexRollout(path: string, chunkBytes = 1024 * 1024): Promise<Message[]> {
  return (await loadCodexRolloutSnapshot(path, chunkBytes)).messages;
}
