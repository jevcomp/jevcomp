import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { bindAuditSource } from './audit.js';
import { auditConfig, auditRoot, digest, reserveBytes, withAuditLock } from './audit-store.js';
import type { Env } from './provider.js';
import type { Message } from './types.js';

interface SessionJournal {
  seen: Set<string>;
  touchedAt: number;
}

export interface AgyAuditJournalState {
  sessions: Map<string, SessionJournal>;
}

const MAX_SESSIONS = 64;

export function createAgyAuditJournalState(): AgyAuditJournalState {
  return { sessions: new Map() };
}

function sessionJournal(state: AgyAuditJournalState, sessionId: string): SessionJournal {
  const existing = state.sessions.get(sessionId);
  if (existing) {
    existing.touchedAt = Date.now();
    return existing;
  }
  const created = { seen: new Set<string>(), touchedAt: Date.now() };
  state.sessions.set(sessionId, created);
  if (state.sessions.size > MAX_SESSIONS) {
    const oldest = [...state.sessions.entries()]
      .sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0]?.[0];
    if (oldest && oldest !== sessionId) state.sessions.delete(oldest);
  }
  return created;
}

function inputText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
}

function messageKeys(messages: readonly Message[]): Array<{ key: string; message: Message }> {
  const seen = new Map<string, number>();
  return messages.map((message) => {
    const hash = digest(JSON.stringify(message));
    const occurrence = seen.get(hash) ?? 0;
    seen.set(hash, occurrence + 1);
    return { key: `${hash}:${occurrence}`, message };
  });
}

export async function appendAgyOutbound(
  env: Env,
  state: AgyAuditJournalState,
  sessionId: string,
  messages: readonly Message[],
  auditId?: string,
): Promise<void> {
  try {
    const config = await auditConfig(env);
    const mode = config.agents.agy;
    if (!mode || !sessionId) return;
    const session = sessionJournal(state, sessionId);
    const fresh = messageKeys(messages).filter((item) => !session.seen.has(item.key));
    if (!fresh.length) return;

    const at = new Date().toISOString();
    const rows = fresh.map(({ key, message }) => ({
      type: 'agy_outbound',
      timestamp: at,
      sessionId,
      ...(auditId ? { auditId } : {}),
      key,
      role: message.role,
      textHashes: message.text ? [digest(message.text)] : [],
      calls: message.toolCalls.map((call) => ({
        id: call.id,
        tool: call.name,
        inputHash: digest(inputText(call.input)),
      })),
      results: (message.toolResults ?? []).map((result) => ({
        id: result.callId,
        outputHash: digest(result.output),
        chars: result.output.length,
      })),
      ...(mode === 'evidence' ? { message } : {}),
    }));
    const encoded = rows.map((row) => JSON.stringify(row) + '\n').join('');
    const directory = join(auditRoot(env), 'agy-sources');
    const path = join(directory, `${digest(sessionId)}.jsonl`);

    await withAuditLock(env, async () => {
      await reserveBytes(env, Buffer.byteLength(encoded), config.maxBytes);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await appendFile(path, encoded, { mode: 0o600 });
    });
    for (const item of fresh) session.seen.add(item.key);
    await bindAuditSource(env, 'agy', sessionId, path);
  } catch {}
}
