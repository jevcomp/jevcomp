import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { VERSION } from './version.js';
import type { Env } from './provider.js';
import type { Message } from './types.js';
import { auditConfig, auditRoot, atomicJson, digest, EvidenceGraph, persistGraph, readJson, reserveBytes, validId, withAuditLock, type AuditAgent, type AuditMode } from './audit-store.js';

export type AuditObserver = (event: string, value: unknown) => void;
export interface AuditManifest {
  schema: 1;
  id: string;
  agent: AuditAgent;
  sessionId?: string;
  agentId?: string;
  sessionSource: 'native' | 'proxy' | 'unknown';
  adapterPolicy?: 'agy-preserve-call-result-only-v1';
  decisionScope?: {
    evaluated: string[];
    reused: { callId: string; stableKey: string; originAuditId?: string }[];
    stableKeys: Record<string, string>;
    projections?: Record<string, { selected: string; applied: string }>;
  };
  wire?: { inputHash: string; outputHash: string; inputBytes: number; outputBytes: number };
  transcript?: string;
  transcriptOffset?: number;
  startedAt: string;
  endedAt?: string;
  mode: AuditMode;
  version: string;
  build: string;
  policy: 'conservative-prefix-v1' | 'conservative-head-tail-v2';
  stage: 'started' | 'evaluated' | 'result_produced' | 'rejected' | 'failed';
  reason?: string;
  historyRecorded?: boolean;
  settings: Record<string, unknown>;
  hashes: Record<string, string>;
  references: Record<string, string>;
  batches: { questionsHash: string; responseHash?: string; questionsRef?: string; responseRef?: string }[];
  attempts: { attempt: number; status?: number; failed?: boolean }[];
  calls: { id: string; occurrence: number; inputHash: string; resultHashes: string[]; resultLengths: number[]; inputChars: number; messageIndex: number; isError: boolean }[];
  gaps: string[];
  beginMs: number;
  captureMs: number;
  observedInputHash: string;
  outputHash?: string;
}

let buildIdentity: Promise<string> | undefined;
function buildHash(): Promise<string> {
  return buildIdentity ??= Promise.all(['compact.js', 'provider.js', 'claude.js', 'claude-compact.js', 'codex-proxy.js', 'codex-compaction.js', 'agy-compact.js', 'agy-proxy.js', 'agy-audit.js', 'render.js', 'audit.js'].map(async name => {
    try { return await readFile(fileURLToPath(new URL(name, import.meta.url)), 'utf8'); }
    catch { return `${name}:unavailable`; }
  })).then(parts => digest(parts.join('\n')));
}

export function observeAudit(observer: AuditObserver | undefined, event: string, value: unknown): void {
  try { observer?.(event, value); } catch {}
}

function inputText(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value); }
export function messageHash(messages: readonly Message[]): string { return digest(JSON.stringify(messages)); }

export class AuditCapture {
  private readonly graph: EvidenceGraph;
  private captureTime = 0;
  private closed = false;
  readonly manifest: AuditManifest;
  constructor(private readonly env: Env, private readonly quota: number, limit: number, manifest: AuditManifest) {
    this.graph = new EvidenceGraph(limit);
    this.manifest = manifest;
  }

  readonly observe: AuditObserver = (event, value) => {
    if (this.closed) return;
    const start = performance.now();
    try {
      const encoded = JSON.stringify(value);
      const hash = digest(encoded);
      this.manifest.hashes[event] = hash;
      if (event === 'settings') this.manifest.settings = { ...this.manifest.settings, ...(value as Record<string, unknown>), goal: undefined };
      if (event === 'decisionScope') { this.manifest.decisionScope = value as AuditManifest['decisionScope']; return; }
      if (event === 'wire') { this.manifest.wire = value as AuditManifest['wire']; return; }
      if (event === 'attempt') { if (this.manifest.attempts.length < 1000) this.manifest.attempts.push(value as AuditManifest['attempts'][number]); return; }
      const reference = this.manifest.mode === 'evidence' ? this.graph.pack(value) : undefined;
      if (event === 'questions') this.manifest.batches.push({ questionsHash: hash, questionsRef: reference });
      else if (event === 'response') {
        const response = value as { questionsHash: string; response: unknown };
        const batch = this.manifest.batches.find(item => item.questionsHash === response.questionsHash && !item.responseHash);
        if (batch) { batch.responseHash = digest(JSON.stringify(response.response)); batch.responseRef = reference; }
      } else if (reference) this.manifest.references[event] = reference;
    } catch (error) { this.gap(error); }
    finally { this.captureTime += performance.now() - start; }
  };

  private gap(error: unknown): void {
    const reason = error instanceof Error ? error.message : 'audit capture failed';
    if (!this.manifest.gaps.includes(reason)) this.manifest.gaps.push(reason.slice(0, 180));
  }

  async finish(stage: AuditManifest['stage'], reason: string, historyRecorded: boolean, output?: unknown): Promise<void> {
    const finishStarted = performance.now();
    if (this.closed) return;
    if (output !== undefined) {
      this.observe('hostOutput', output);
      this.manifest.outputHash = digest(JSON.stringify(output));
    }
    this.closed = true;
    Object.assign(this.manifest, { stage, reason, historyRecorded, endedAt: new Date().toISOString() });
    try {
      await withAuditLock(this.env, async () => {
        try { await persistGraph(this.env, this.graph, Math.max(0, this.quota - 128 * 1024)); }
        catch (error) { this.gap(error); }
        this.manifest.captureMs = this.captureTime + performance.now() - finishStarted;
        await reserveBytes(this.env, Buffer.byteLength(JSON.stringify(this.manifest)), this.quota);
        await atomicJson(join(auditRoot(this.env), 'evaluations', `${this.manifest.id}.json`), this.manifest);
      });
    } catch (error) {
      this.gap(error);
      await this.failureMarker();
    }
  }

  private async failureMarker(): Promise<void> {
    try { await atomicJson(join(auditRoot(this.env), 'last-failure.json'), { at: new Date().toISOString(), id: this.manifest.id, gaps: this.manifest.gaps }); } catch {}
  }
}

export async function beginAudit(env: Env, agent: AuditAgent, id: string, messages: readonly Message[], settings: Record<string, unknown>, sessionId?: string, agentId?: string, extra: Pick<AuditManifest, 'sessionSource' | 'adapterPolicy'> = { sessionSource: sessionId ? 'native' : 'unknown' }): Promise<AuditCapture | undefined> {
  const beginStarted = performance.now();
  try {
    const config = await auditConfig(env), mode = config.agents[agent];
    if (!mode) return undefined;
    if (!validId(id)) throw Error('invalid evaluation ID');
    let transcript: string | undefined, transcriptOffset: number | undefined;
    if (sessionId) {
      try {
        const binding = await readJson<{ path: string }>(join(auditRoot(env), 'sources', `${digest(`${agent}:${sessionId}:${agentId ?? ''}`)}.json`));
        transcript = binding.path;
        transcriptOffset = (await stat(transcript)).size;
      } catch {}
    }
    const seen = new Map<string, number>();
    const outputsById = new Map<string, { output: string; isError?: boolean }[]>();
    for (const message of messages) for (const output of message.toolResults ?? []) {
      const group = outputsById.get(output.callId) ?? [];
      group.push(output);
      outputsById.set(output.callId, group);
    }
    const calls: AuditManifest['calls'] = [];
    messages.forEach((message, index) => message.toolCalls.forEach(call => {
      const outputs = outputsById.get(call.id) ?? [];
      const occurrence = seen.get(call.id) ?? 0;
      seen.set(call.id, occurrence + 1);
      calls.push({ id: call.id, occurrence, inputHash: digest(inputText(call.input)), resultHashes: outputs.map(item => digest(item.output)), resultLengths: outputs.map(item => item.output.length), inputChars: inputText(call.input).length, messageIndex: index, isError: outputs.some(item => !!item.isError) });
    }));
    const manifest: AuditManifest = {
      schema: 1, id, agent, sessionId, agentId, sessionSource: extra.sessionSource, adapterPolicy: extra.adapterPolicy, transcript, transcriptOffset,
      startedAt: new Date().toISOString(), mode, version: VERSION, build: await buildHash(), policy: 'conservative-head-tail-v2', stage: 'started',
      settings, hashes: {}, references: {}, batches: [], attempts: [], calls, gaps: [], beginMs: 0, captureMs: 0, observedInputHash: messageHash(messages),
    };
    if (!sessionId) manifest.gaps.push('native session identity unavailable');
    if ([...seen.values()].some(count => count > 1)) manifest.gaps.push('duplicate native call identifiers');
    await withAuditLock(env, async () => {
      await reserveBytes(env, Buffer.byteLength(JSON.stringify(manifest)), config.maxBytes);
      await atomicJson(join(auditRoot(env), 'evaluations', `${id}.json`), manifest);
    });
    const capture = new AuditCapture(env, config.maxBytes, config.captureBytes, manifest);
    capture.observe('input', messages);
    manifest.beginMs = performance.now() - beginStarted;
    return capture;
  } catch (error) {
    try { await atomicJson(join(auditRoot(env), 'last-failure.json'), { at: new Date().toISOString(), id, reason: error instanceof Error ? error.message : 'audit initialization failed' }); } catch {}
    return undefined;
  }
}

export async function bindAuditSource(env: Env, agent: AuditAgent, sessionId: string, path: string, agentId?: string): Promise<void> {
  try {
    const config = await auditConfig(env);
    if (!config.agents[agent] || !sessionId || !path) return;
    const bindingPath = join(auditRoot(env), 'sources', `${digest(`${agent}:${sessionId}:${agentId ?? ''}`)}.json`);
    try {
      const existing = await readJson<{ agent: AuditAgent; sessionId: string; agentId?: string; path: string }>(bindingPath);
      if (existing.agent === agent && existing.sessionId === sessionId && existing.agentId === agentId && existing.path === path) return;
    } catch {}
    await withAuditLock(env, async () => {
      await reserveBytes(env, Buffer.byteLength(path) + 256, config.maxBytes);
      await atomicJson(bindingPath, { agent, sessionId, agentId, path });
    });
  } catch {}
}

export async function auditEvent(env: Env, id: string, event: 'transport_finished', evidence: string): Promise<void> {
  if (!validId(id)) return;
  try {
    const config = await auditConfig(env);
    await withAuditLock(env, async () => {
      await reserveBytes(env, 512, config.maxBytes);
      await atomicJson(join(auditRoot(env), 'events', `${id}.json`), { id, event, at: new Date().toISOString(), evidence });
    });
  } catch {}
}

export async function auditManifests(env: Env): Promise<{ manifests: AuditManifest[]; corrupt: string[] }> {
  const manifests: AuditManifest[] = [], corrupt: string[] = [];
  for (const name of await readdir(join(auditRoot(env), 'evaluations')).catch(() => [])) {
    if (!name.endsWith('.json')) continue;
    try {
      const manifest = await readJson<AuditManifest>(join(auditRoot(env), 'evaluations', name));
      if (manifest.schema !== 1 || !validId(manifest.id) || name !== `${manifest.id}.json`) throw Error('invalid schema');
      manifests.push(manifest);
    } catch { corrupt.push(name); }
  }
  manifests.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return { manifests, corrupt };
}
