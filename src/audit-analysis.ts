import { readHistory, type HistoryRow } from './store.js';
import { auditManifests, type AuditManifest } from './audit.js';
import { auditRoot, digest, readJson, unpackEvidence } from './audit-store.js';
import { indexTranscript, sourceRecord, blockText, type SourceIndex, type SourceEvent } from './audit-sources.js';
import { join } from 'node:path';
import type { Env } from './provider.js';
import type { CallDecision, Message } from './types.js';
import { estimateTokens } from './compact.js';
import { renderMessages } from './render.js';

export interface AuditCase {
  id: string; evaluationId: string; callId: string; callKey: string; agent: string; tool: string;
  action: string; proposedAction: string; pinned: boolean; dropLoss: number | null; truncateLoss: number | null;
  ruleConforms: boolean | null; originalChars: number; resultChars: number; savedChars: number;
  application: string; tags: string[];
  observation: { coverage: string; eventsObserved: number; windows: Record<string, string>; matches: { kind: string; event: SourceEvent }[]; gaps: string[] };
}
export interface AuditAnalysis {
  manifests: AuditManifest[]; rows: Map<string, HistoryRow>; cases: AuditCase[];
  sources: Map<string, SourceIndex | undefined>;
  corrupt: string[];
}

export function expectedAction(decision: CallDecision, manifest: AuditManifest, dropLimit?: number, truncateLimit?: number): CallDecision['action'] | undefined {
  if (decision.pinned) return 'keep';
  const limit = Number(manifest.settings.lossThreshold);
  const head = Number(manifest.settings.truncateHeadChars);
  if (!Number.isFinite(limit) || !Number.isInteger(head)) return undefined;
  const drop = dropLimit ?? limit, truncate = truncateLimit ?? limit;
  if (decision.truncateLoss >= truncate) return 'keep';
  if (decision.dropLoss < drop) return 'drop_call';
  return shortenedLength(decision.resultChars, head) < decision.resultChars ? 'truncate_result' : 'keep';
}

export function shortenedLength(length: number, head: number): number {
  if (length <= head) return length;
  return (head ? head + 1 : 0) + `[jevcomp omitted ${length - head} chars; rerun tool if needed]`.length;
}

async function outputMessages(env: Env, manifest: AuditManifest, key: 'input' | 'output'): Promise<Message[] | undefined> {
  const ref = manifest.references[key];
  if (!ref) return undefined;
  try { return await unpackEvidence(env, ref) as Message[]; } catch { return undefined; }
}

async function applicationEvidence(env: Env, manifest: AuditManifest, source: SourceIndex | undefined, following: AuditManifest | undefined): Promise<string> {
  if (manifest.stage !== 'result_produced') return 'not_applied';
  const boundary = source?.events.find(event => event.kind === 'boundary' && event.at >= manifest.startedAt && event.textHashes?.includes(manifest.outputHash ?? ''));
  if (boundary && manifest.agent === 'codex') return 'native_compaction_output_matched';
  if (manifest.agent === 'codex' && source?.events.some(event => event.kind === 'boundary' && event.encrypted && event.at >= manifest.startedAt)) return 'native_boundary_encrypted_unconfirmed';
  if (manifest.agent === 'claude' && following) {
    const previousOutput = await outputMessages(env, manifest, 'output');
    const laterInput = await outputMessages(env, following, 'input');
    if (previousOutput?.length && laterInput && digest(JSON.stringify(previousOutput)) !== manifest.observedInputHash && laterInput.length >= previousOutput.length && JSON.stringify(previousOutput) === JSON.stringify(laterInput.slice(0, previousOutput.length))) return 'next_compaction_input_matched';
  }
  if (manifest.agent === 'codex') {
    try {
      const event = await readJson<{ event: string }>(join(auditRoot(env), 'events', `${manifest.id}.json`));
      if (event.event === 'transport_finished') return 'transport_finished_consumption_unconfirmed';
    } catch {}
  }
  return 'unconfirmed';
}

function excerpts(output: string, head = 0): string[] {
  const remainder = output.slice(head);
  if (remainder.length < 80) return [];
  const positions = [0, Math.floor(remainder.length / 3), Math.floor(remainder.length * 2 / 3), Math.max(0, remainder.length - 80)];
  return [...new Set(positions.map(position => remainder.slice(position, position + 80)).filter(part => new Set(part).size > 8))];
}

async function observations(source: SourceIndex | undefined, manifest: AuditManifest, decision: CallDecision, original: Message[] | undefined, readSource: (event: SourceEvent) => Promise<any>): Promise<AuditCase['observation']> {
  if (manifest.stage !== 'result_produced') return { coverage: 'not_applied', eventsObserved: 0, windows: {}, matches: [], gaps: ['proposed cut was not returned'] };
  if (!source) return { coverage: 'unavailable', eventsObserved: 0, windows: {}, matches: [], gaps: ['native transcript unavailable'] };
  const ownBoundary = source.events.find(event => event.kind === 'boundary' && event.at >= manifest.startedAt);
  const nextBoundary = ownBoundary && source.events.find(event => event.kind === 'boundary' && event.offset > ownBoundary.offset);
  const after = source.events.filter(event => event.at > (manifest.endedAt ?? manifest.startedAt) && (!ownBoundary || event.offset > ownBoundary.offset) && (!nextBoundary || event.offset < nextBoundary.offset));
  const turns = new Set(after.filter(event => event.kind === 'assistant_message').map(event => event.id ?? event.hash)).size;
  const call = manifest.calls.find(call => call.id === decision.callId);
  const matches = after.filter(event => event.kind === 'result' && event.id !== decision.callId && event.outputHash && call?.resultHashes.includes(event.outputHash)).map(event => ({ kind: 'identical_result_reappeared', event }));
  const originalOutputs = original?.flatMap(message => message.toolResults ?? []).filter(result => result.callId === decision.callId).map(result => result.output) ?? [];
  if (originalOutputs.length && decision.action !== 'drop_call') {
    const head = decision.action === 'truncate_result' ? Number(manifest.settings.truncateHeadChars) : 0;
    const needles = originalOutputs.flatMap(output => excerpts(output, head));
    let scanned = 0;
    for (const event of after) {
      if (scanned >= 1024 * 1024 || matches.length >= 5) break;
      if (decision.action === 'truncate_result' && event.kind !== 'result') continue;
      if (decision.action === 'keep' && event.kind !== 'text') continue;
      try {
        const row = await readSource(event);
        if (decision.action === 'keep' && row.type !== 'assistant') continue;
        const content = manifest.agent === 'claude' ? row.message?.content : row.payload?.content ?? row.payload?.output;
        let text = '';
        if (decision.action === 'keep' && Array.isArray(content)) text = content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n');
        else if (decision.action === 'truncate_result' && manifest.agent === 'claude' && Array.isArray(content)) text = content.filter((item: any) => item.type === 'tool_result').map((item: any) => blockText(item.content)).join('\n');
        else if (decision.action === 'truncate_result') text = blockText(content);
        scanned += text.length;
        if (needles.some(needle => text.includes(needle))) matches.push({ kind: decision.action === 'keep' ? 'kept_excerpt_explicitly_reused' : 'omitted_excerpt_reappeared', event });
      } catch { if (!source.gaps.includes('source record unavailable during correlation')) source.gaps.push('source record unavailable during correlation'); }
    }
  }
  const windows: Record<string, string> = {};
  for (const window of [5, 10, 20]) windows[String(window)] = turns >= window ? 'observed' : 'incomplete';
  return { coverage: source.gaps.length ? 'partial' : 'observed_until_source_end_or_boundary', eventsObserved: turns, windows, matches, gaps: source.gaps };
}

export async function analyzeAudit(env: Env): Promise<AuditAnalysis> {
  const { manifests, corrupt } = await auditManifests(env);
  const rows = new Map((await readHistory(env)).filter(row => row.phase === 'precompact' && row.auditId).map(row => [row.auditId!, row]));
  const sources = new Map<string, SourceIndex | undefined>(), sourcesBySession = new Map<string, SourceIndex | undefined>();
  const cases: AuditCase[] = [];
  const sourceRecords = new Map<string, Promise<any>>();
  for (const manifest of manifests) {
    const sessionKey = `${manifest.agent}:${manifest.sessionId ?? manifest.id}:${manifest.agentId ?? ''}`;
    if (!sourcesBySession.has(sessionKey)) {
      try { sourcesBySession.set(sessionKey, await indexTranscript(env, manifest)); } catch { sourcesBySession.set(sessionKey, undefined); }
    }
    const source = sourcesBySession.get(sessionKey);
    sources.set(manifest.id, source);
    const following = manifests.find(item => item.startedAt > manifest.startedAt && item.agent === manifest.agent && item.sessionId && item.sessionId === manifest.sessionId && item.agentId === manifest.agentId);
    const application = await applicationEvidence(env, manifest, source, following);
    const original = await outputMessages(env, manifest, 'input');
    const decisions = rows.get(manifest.id)?.decisions ?? [];
    for (const [ordinal, decision] of decisions.entries()) {
      const expected = expectedAction(decision, manifest);
      const observation = await observations(source, manifest, decision, original, event => {
        const key = `${source?.path}:${event.offset}`;
        if (!sourceRecords.has(key)) sourceRecords.set(key, sourceRecord(source!, event));
        return sourceRecords.get(key)!;
      });
      const tags = [];
      if (decision.action === 'truncate_result') tags.push('shortened');
      if (!decision.pinned && decision.truncateLoss > decision.dropLoss) tags.push('risk_order_inversion');
      if (!decision.pinned && Math.min(Math.abs(decision.dropLoss - Number(manifest.settings.lossThreshold)), Math.abs(decision.truncateLoss - Number(manifest.settings.lossThreshold))) <= 0.05) tags.push('near_threshold');
      if (observation.matches.some(match => match.kind === 'identical_result_reappeared' || match.kind === 'omitted_excerpt_reappeared')) tags.push('result_reappeared');
      if (observation.matches.some(match => match.kind === 'kept_excerpt_explicitly_reused')) tags.push('kept_excerpt_reused');
      if (decision.action === 'keep' && !decision.pinned && decision.originalChars > 5000) tags.push('large_kept');
      if (expected && expected !== decision.action) tags.push('policy_mismatch');
      cases.push({ id: `${manifest.id}_${ordinal}`, evaluationId: manifest.id, callId: decision.callId,
        callKey: `${sessionKey}:${decision.callId || `occurrence:${ordinal}`}`, agent: manifest.agent, tool: decision.name,
        proposedAction: decision.action, action: manifest.stage === 'rejected' || manifest.stage === 'failed' ? 'not_applied' : decision.action,
        pinned: decision.pinned, dropLoss: decision.pinned ? null : decision.dropLoss, truncateLoss: decision.pinned ? null : decision.truncateLoss,
        ruleConforms: expected ? expected === decision.action : null, originalChars: decision.originalChars, resultChars: decision.resultChars, savedChars: decision.savedChars,
        application, tags, observation });
    }
  }
  return { manifests, rows, cases, sources, corrupt };
}

export function auditReport(analysis: AuditAnalysis, seed = 'jev-audit-v1', limit = 30) {
  const { cases, manifests, rows } = analysis;
  const captureTimes = manifests.map(item => item.beginMs + item.captureMs).filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = (fraction: number) => captureTimes.length ? Math.round(captureTimes[Math.min(captureTimes.length - 1, Math.ceil(captureTimes.length * fraction) - 1)]!) : null;
  const first = [...new Map([...cases].reverse().map(item => [item.callKey, item])).values()];
  const nonPinned = cases.filter(item => !item.pinned);
  const countActions = (items: AuditCase[]) => Object.fromEntries(['keep', 'truncate_result', 'drop_call'].map(action => [action, items.filter(item => item.proposedAction === action).length]));
  const ordered = [...cases].sort((a, b) => digest(`${seed}:${a.id}`).localeCompare(digest(`${seed}:${b.id}`)));
  const sample: { id: string; reason: string }[] = [], sampled = new Set<string>();
  const add = (item: AuditCase, reason: string) => { if (sample.length < limit && !sampled.has(item.callKey)) { sample.push({ id: item.id, reason }); sampled.add(item.callKey); } };
  for (const item of ordered.slice(0, Math.ceil(limit * 0.2))) add(item, 'seeded_random');
  for (const tag of ['policy_mismatch', 'shortened', 'result_reappeared', 'near_threshold', 'risk_order_inversion', 'large_kept']) {
    let taken = 0;
    for (const item of ordered) if (item.tags.includes(tag) && taken < Math.ceil(limit / 6)) { const before = sample.length; add(item, tag); taken += sample.length - before; }
  }
  for (const item of ordered) add(item, 'seeded_random_fill');
  const eligible = nonPinned.filter(item => {
    const manifest = manifests.find(manifest => manifest.id === item.evaluationId)!;
    return shortenedLength(item.resultChars, Number(manifest.settings.truncateHeadChars)) < item.resultChars;
  });
  return {
    schema: 1, generatedAt: new Date().toISOString(), units: { text: 'UTF-16 code units (same as compactor String.length)', continuation: 'unique assistant messages; not billed requests' },
    limitations: ['No causal attribution or optimal-policy claim', 'No character-to-token conversion', 'Reappearance is not proof of harm', 'No explicit reference is not proof of uselessness', 'Simulations use fixed original scores and snapshots'],
    coverage: { evaluations: manifests.length, corrupt: analysis.corrupt, partial: manifests.filter(item => item.gaps.length).length, pending: manifests.filter(item => item.stage === 'started').length, missingHistory: manifests.filter(item => !rows.has(item.id)).length, unavailableSources: manifests.filter(item => !analysis.sources.get(item.id)).length },
    policy: { checked: cases.filter(item => item.ruleConforms !== null).length, mismatches: cases.filter(item => item.ruleConforms === false).map(item => item.id), unknown: cases.filter(item => item.ruleConforms === null).length },
    counts: { decisions: cases.length, uniqueCalls: first.length, allEvaluations: countActions(cases), firstEvaluations: countActions(first), rejected: manifests.filter(item => item.stage === 'rejected').length },
    shorteningFunnel: { unprotected: nonPinned.length, positiveSizeSavings: eligible.length, favorableRiskPair: eligible.filter(item => item.proposedAction === 'truncate_result').length, accepted: eligible.filter(item => item.action === 'truncate_result').length, applicationObserved: eligible.filter(item => item.action === 'truncate_result' && ['native_compaction_output_matched', 'next_compaction_input_matched'].includes(item.application)).length },
    riskInversions: nonPinned.filter(item => item.tags.includes('risk_order_inversion')).length,
    reappearances: { cases: cases.filter(item => item.tags.includes('result_reappeared')).length, withObservedApplication: cases.filter(item => item.tags.includes('result_reappeared') && ['native_compaction_output_matched', 'next_compaction_input_matched'].includes(item.application)).length },
    application: Object.fromEntries(['not_applied', 'unconfirmed', 'transport_finished_consumption_unconfirmed', 'native_boundary_encrypted_unconfirmed', 'native_compaction_output_matched', 'next_compaction_input_matched'].map(status => [status, manifests.filter(manifest => cases.some(item => item.evaluationId === manifest.id && item.application === status)).length])),
    keptExcerptReused: cases.filter(item => item.tags.includes('kept_excerpt_reused')).length,
    providerUsage: {
      reportedEvaluations: manifests.filter(item => Number(rows.get(item.id)?.stats?.jevUsageReportedRequests) > 0).length,
      evaluatedInputTokensReported: manifests.reduce((sum, item) => sum + (rows.get(item.id)?.stats?.jevInputTokens ?? 0), 0),
      evaluatedOutputTokensReported: manifests.reduce((sum, item) => sum + (rows.get(item.id)?.stats?.jevOutputTokens ?? 0), 0),
      rejectedInputTokensReported: manifests.filter(item => item.stage === 'rejected').reduce((sum, item) => sum + (rows.get(item.id)?.stats?.jevInputTokens ?? 0), 0),
      attemptsObserved: manifests.reduce((sum, item) => sum + item.attempts.length, 0),
    },
    localCaptureMilliseconds: { samples: captureTimes.length, median: percentile(0.5), p95: percentile(0.95), maximum: percentile(1) },
    sample: { seed, limit, selected: sample, excludedDecisions: cases.length - sample.length, representativeErrorRate: 'not estimated from directed sample' },
  };
}

export async function inspectAuditCase(env: Env, analysis: AuditAnalysis, id: string) {
  const selected = analysis.cases.find(item => item.id === id);
  if (!selected) throw Error('audit case not found');
  const manifest = analysis.manifests.find(item => item.id === selected.evaluationId)!;
  const input = await outputMessages(env, manifest, 'input');
  const output = await outputMessages(env, manifest, 'output');
  let jevState: any;
  try { if (manifest.references.state) jevState = await unpackEvidence(env, manifest.references.state); } catch {}
  const source = analysis.sources.get(manifest.id);
  const later = [];
  for (const match of selected.observation.matches.slice(0, 3)) {
    try { later.push({ ...match, record: source ? await sourceRecord(source, match.event) : undefined }); }
    catch { later.push({ ...match, unavailable: true }); }
  }
  let review: unknown;
  try { review = await readJson(join(auditRoot(env), 'reviews', `${id}.json`)); } catch {}
  const relevant = (messages: Message[] | undefined) => messages?.filter(message => message.toolCalls.some(call => call.id === selected.callId) || message.toolResults?.some(result => result.callId === selected.callId));
  const callIndex = input?.findIndex(message => message.toolCalls.some(call => call.id === selected.callId)) ?? -1;
  const nearbyMessages = callIndex < 0 ? [] : input!.slice(Math.max(0, callIndex - 4), callIndex).map(message => ({ role: message.role, text: message.text }));
  const jevHistory = Array.isArray(jevState?.history) ? jevState.history : [];
  const observedJevContext = jevHistory.filter((item: any) => JSON.stringify(item).includes(selected.callId)).slice(0, 5);
  const evaluation = { id: manifest.id, agent: manifest.agent, sessionId: manifest.sessionId, startedAt: manifest.startedAt, stage: manifest.stage,
    reason: manifest.reason, settings: manifest.settings, version: manifest.version, build: manifest.build, policy: manifest.policy, gaps: manifest.gaps };
  return { case: selected, evaluation, before: relevant(input), after: relevant(output), nearbyMessages, jevContext: { instructions: jevState?.context, goal: jevState?.goal, matchingEntries: observedJevContext, fullStateReference: manifest.references.state }, later, review, evidenceAvailable: !!input && !!output,
    reviewQuestions: ['Was information needed at this point or only later?', 'Was it available elsewhere?', 'Was recovery acceptable?', 'Would the original prefix suffice?', 'Is there observed harm or only a hypothesis?', 'Which evidence is missing?'] };
}

export async function simulateAudit(env: Env, analysis: AuditAnalysis, dropLimit: number, truncateLimit: number, minimum?: number) {
  for (const value of [dropLimit, truncateLimit, ...(minimum === undefined ? [] : [minimum])]) if (!Number.isFinite(value) || value < 0 || value > 1) throw Error('thresholds must be between 0 and 1');
  const results = [];
  for (const manifest of analysis.manifests) {
    const input = await outputMessages(env, manifest, 'input');
    const row = analysis.rows.get(manifest.id);
    if (!input || !row?.decisions || manifest.gaps.some(gap => gap.includes('duplicate'))) { results.push({ id: manifest.id, status: 'insufficient_evidence' }); continue; }
    const head = Number(manifest.settings.truncateHeadChars);
    const decisions = new Map(row.decisions.map(decision => [decision.callId, expectedAction(decision, manifest, dropLimit, truncateLimit)]));
    if ([...decisions.values()].some(action => !action)) { results.push({ id: manifest.id, status: 'unsupported_settings' }); continue; }
    const proposed: Message[] = input.map(message => ({ ...message,
      toolCalls: message.toolCalls.filter(call => decisions.get(call.id) !== 'drop_call'),
      toolResults: message.toolResults?.filter(result => decisions.get(result.callId) !== 'drop_call').map(result => {
        if (decisions.get(result.callId) !== 'truncate_result' || shortenedLength(result.output.length, head) >= result.output.length) return result;
        return { ...result, output: `${head ? result.output.slice(0, head) + '\n' : ''}[jevcomp omitted ${Math.max(0, result.output.length - head)} chars; rerun tool if needed]` };
      }),
    })).filter(message => message.text.trim() || message.toolCalls.length || message.toolResults?.length);
    const chars = (messages: Message[]) => messages.reduce((sum, message) => sum + message.text.length + message.toolCalls.reduce((n, call) => n + (typeof call.input === 'string' ? call.input : JSON.stringify(call.input) ?? String(call.input)).length, 0) + (message.toolResults ?? []).reduce((n, result) => n + result.output.length, 0), 0);
    const before = chars(input), after = chars(proposed), reduction = before ? (before - after) / before : 0;
    let accepted = reduction >= (minimum ?? Number(manifest.settings.minReductionRatio));
    let rejection = accepted ? undefined : 'below_minimum';
    if (manifest.agent === 'codex') {
      const summary = renderMessages(proposed.filter(message => message.role !== 'developer' && message.role !== 'system'));
      if (!summary.trim() || estimateTokens(summary) > Number(manifest.settings.maxSummaryTokens)) { accepted = false; rejection = 'host_output_constraint'; }
    }
    results.push({ id: manifest.id, before, after, reduction, accepted, rejection, changes: row.decisions.filter(decision => decisions.get(decision.callId) !== decision.action).map(decision => ({ callId: decision.callId, from: decision.action, to: decisions.get(decision.callId) })) });
  }
  return { scope: 'independent original snapshots; downstream behavior is not simulated', dropLimit, truncateLimit, minimum, results };
}
