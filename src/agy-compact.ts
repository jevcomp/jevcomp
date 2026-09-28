import { compact, shortenToolResult, type CompactOptions } from './compact.js';
import { digest } from './audit-store.js';
import { JevClient, type JevClientOptions } from './provider.js';
import { jevCompactOptions } from './hooks.js';
import { userSettings } from './settings.js';
import type { CallDecision, CompactStats, JevAsker, JevQuestions, JevResponse, Message } from './types.js';

type RecordValue = Record<string, unknown>;
type PlanAction = CallDecision['action'];

interface PartRef {
  contentIndex: number;
  partIndex: number;
  kind: 'function' | 'tool';
  name?: string;
  id?: string;
  value: RecordValue;
}

interface ResponseRef extends PartRef {
  result: string;
  resultKey: string;
  resultInResponse: boolean;
}

interface Pair {
  call: PartRef;
  response: ResponseRef;
  callId: string;
  fingerprint: string;
  pinned: boolean;
}

interface SessionPlan {
  contextKey: string;
  actions: Map<string, PlanAction>;
  touchedAt: number;
}

export interface AgyCompactionState {
  sessions: Map<string, SessionPlan>;
}

export interface AgyCompactResult {
  payload: RecordValue;
  changed: boolean;
  providerAsked: boolean;
  providerFailed: boolean;
  planUpdated: boolean;
  sessionId: string;
  stats: CompactStats;
  decisions: CallDecision[];
  reductionRatio: number;
}

export interface AgyCompactOptions extends CompactOptions {
  minReductionRatio?: number;
  minEligibleChars?: number;
}

const DEFAULT_MIN_ELIGIBLE_CHARS = 2_000;
const MAX_SESSIONS = 64;

function record(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function strings(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteOption(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function createAgyCompactionState(): AgyCompactionState {
  return { sessions: new Map() };
}
function requestOf(payload: RecordValue): RecordValue {
  return record(payload.request) ? payload.request : payload;
}

function contentsOf(payload: RecordValue): unknown[] | undefined {
  const request = requestOf(payload);
  return Array.isArray(request.contents) ? request.contents : undefined;
}

function sessionIdOf(payload: RecordValue): string | undefined {
  const request = requestOf(payload);
  return strings(request.sessionId) ?? strings(request.session_id)
    ?? strings(payload.sessionId) ?? strings(payload.session_id)
    ?? strings(request.conversationId) ?? strings(payload.conversationId)
    ?? strings(request.requestId) ?? strings(payload.requestId);
}

function refName(value: RecordValue): string | undefined {
  const explicit = strings(value.name);
  if (explicit) return explicit;
  const toolType = value.toolType;
  if (typeof toolType === 'string' && toolType.length) return toolType;
  if (typeof toolType === 'number' && Number.isFinite(toolType)) return String(toolType);
  return undefined;
}

function plainText(content: unknown): string {
  if (!record(content) || !Array.isArray(content.parts)) return '';
  return content.parts.flatMap((part) => {
    if (!record(part) || part.thought === true || typeof part.text !== 'string') return [];
    return [part.text];
  }).join('\n');
}

function semanticContextKey(contents: readonly unknown[]): string {
  const recent = contents.flatMap((content) => {
    if (!record(content) || (content.role !== 'user' && content.role !== 'model')) return [];
    const text = plainText(content).trim();
    return text ? [{ role: content.role, text }] : [];
  }).slice(-4);
  return digest(JSON.stringify(recent));
}

function stringResult(value: RecordValue, keys: readonly string[]): { result: string; resultKey: string; resultInResponse: boolean } | undefined {
  for (const key of keys) {
    if (typeof value[key] === 'string') return { result: value[key] as string, resultKey: key, resultInResponse: false };
  }
  const body = record(value.response) ? value.response : undefined;
  if (!body) return undefined;
  for (const key of keys) {
    if (typeof body[key] === 'string') return { result: body[key] as string, resultKey: key, resultInResponse: true };
  }
  return undefined;
}

function collectRefs(contents: readonly unknown[]): { calls: PartRef[]; responses: ResponseRef[] } {
  const calls: PartRef[] = [];
  const responses: ResponseRef[] = [];
  contents.forEach((content, contentIndex) => {
    if (!record(content) || !Array.isArray(content.parts)) return;
    content.parts.forEach((part, partIndex) => {
      if (!record(part)) return;
      for (const [kind, key] of [['function', 'functionCall'], ['tool', 'toolCall']] as const) {
        if (!record(part[key])) continue;
        const call = part[key] as RecordValue;
        calls.push({ contentIndex, partIndex, kind, name: refName(call), id: strings(call.id), value: call });
      }
      for (const [kind, key, resultKeys] of [
        ['function', 'functionResponse', ['result', 'output', 'text', 'responseJson', 'response_json']],
        ['tool', 'toolResponse', ['responseJson', 'response_json', 'result', 'output', 'text']],
      ] as const) {
        if (!record(part[key])) continue;
        const response = part[key] as RecordValue;
        const extracted = stringResult(response, resultKeys);
        if (!extracted) continue;
        responses.push({ contentIndex, partIndex, kind, name: refName(response), id: strings(response.id), value: response, ...extracted });
      }
    });
  });
  return { calls, responses };
}

function location(ref: PartRef): number {
  return ref.contentIndex * 1_000_000 + ref.partIndex;
}

function pairRefs(contents: readonly unknown[], preserveRecentMessages: number): Pair[] {
  const { calls, responses } = collectRefs(contents);
  const callIdCounts = new Map<string, number>();
  const responseIdCounts = new Map<string, number>();
  for (const call of calls) if (call.id) callIdCounts.set(call.id, (callIdCounts.get(call.id) ?? 0) + 1);
  for (const response of responses) if (response.id) responseIdCounts.set(response.id, (responseIdCounts.get(response.id) ?? 0) + 1);

  const usedCalls = new Set<PartRef>();
  const provisional: Array<{ call: PartRef; response: ResponseRef }> = [];
  for (const response of responses.sort((a, b) => location(a) - location(b))) {
    let matches: PartRef[] = [];
    if (response.id && callIdCounts.get(response.id) === 1 && responseIdCounts.get(response.id) === 1) {
      matches = calls.filter((call) =>
        call.id === response.id &&
        call.kind === response.kind &&
        (!call.name || !response.name || call.name === response.name) &&
        location(call) < location(response) &&
        !usedCalls.has(call));
    } else if (!response.id && response.name) {
      matches = calls.filter((call) =>
        !call.id &&
        call.kind === response.kind &&
        call.name === response.name &&
        location(call) < location(response) &&
        !usedCalls.has(call));
    }
    if (matches.length !== 1) continue;
    usedCalls.add(matches[0]!);
    provisional.push({ call: matches[0]!, response });
  }

  provisional.sort((a, b) => location(a.call) - location(b.call));
  const seen = new Map<string, number>();
  return provisional.map(({ call, response }, index) => {
    const base = digest(JSON.stringify({ call: call.value, response: response.value }));
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    const recentFrom = Math.max(0, contents.length - preserveRecentMessages);
    return {
      call, response,
      callId: `agy-${index + 1}`,
      fingerprint: `${base}:${occurrence}`,
      pinned: call.contentIndex === 0 || call.contentIndex >= recentFrom || response.contentIndex >= recentFrom,
    };
  });
}
function toMessages(contents: readonly unknown[], pairs: readonly Pair[]): Message[] {
  const callsByContent = new Map<number, Pair[]>();
  const responsesByContent = new Map<number, Pair[]>();
  for (const pair of pairs) {
    callsByContent.set(pair.call.contentIndex, [...(callsByContent.get(pair.call.contentIndex) ?? []), pair]);
    responsesByContent.set(pair.response.contentIndex, [...(responsesByContent.get(pair.response.contentIndex) ?? []), pair]);
  }
  return contents.map((content, index): Message => {
    const role = record(content) && content.role === 'model' ? 'assistant' : 'user';
    const calls = callsByContent.get(index) ?? [];
    const responses = responsesByContent.get(index) ?? [];
    return {
      role,
      text: plainText(content),
      toolCalls: calls.map((pair) => ({
        id: pair.callId,
        name: pair.call.name ?? pair.call.kind,
        input: record(pair.call.value.args)
          ? pair.call.value.args
          : record(pair.call.value.arguments)
            ? pair.call.value.arguments
            : pair.call.value.args ?? pair.call.value.arguments ?? pair.call.value.argumentsJson ?? pair.call.value.arguments_json ?? {},
      })),
      ...(responses.length ? { toolResults: responses.map((pair) => ({ callId: pair.callId, output: pair.response.result })) } : {}),
    };
  });
}

function plannedAnswer(action: PlanAction, kind: 'drop' | 'truncate'): number {
  if (action === 'keep') return 1;
  if (action === 'truncate_result') return kind === 'drop' ? 1 : 0;
  return 0;
}

class PlanAsker implements JevAsker {
  providerAsked = false;
  providerFailed = false;
  providerRequests = 0;

  constructor(
    private readonly delegate: JevAsker,
    private readonly pairsByCandidate: Map<string, Pair>,
    private readonly actions: Map<string, PlanAction>,
    private readonly allowNetwork: boolean,
  ) {}

  async ask(state: Record<string, unknown>, questions: JevQuestions): Promise<JevResponse> {
    const answers: JevResponse['answers'] = {};
    const external: JevQuestions = {};
    for (const [key, question] of Object.entries(questions)) {
      const candidate = record(question.instructions) ? strings(question.instructions.candidate) : undefined;
      const pair = candidate ? this.pairsByCandidate.get(candidate) : undefined;
      const action = pair ? this.actions.get(pair.fingerprint) : undefined;
      if (action) {
        answers[key] = { noul: plannedAnswer(action, key.startsWith('drop_') ? 'drop' : 'truncate') };
      } else if (!this.allowNetwork) {
        answers[key] = { noul: 1 };
      } else {
        external[key] = question;
      }
    }
    if (!Object.keys(external).length) return { answers };
    this.providerAsked = true;
    this.providerRequests++;
    try {
      const response = await this.delegate.ask(state, external);
      return { ...response, answers: { ...answers, ...response.answers } };
    } catch {
      this.providerFailed = true;
      for (const key of Object.keys(external)) answers[key] = { noul: 1 };
      return { answers };
    }
  }
}
function clonePayload(payload: RecordValue): RecordValue {
  return JSON.parse(JSON.stringify(payload)) as RecordValue;
}

function responseResult(payload: RecordValue, pair: Pair): { body: RecordValue; key: string; value: string } | undefined {
  const contents = contentsOf(payload);
  const content = contents?.[pair.response.contentIndex];
  if (!record(content) || !Array.isArray(content.parts)) return undefined;
  const part = content.parts[pair.response.partIndex];
  if (!record(part)) return undefined;
  const holderKey = pair.response.kind === 'function' ? 'functionResponse' : 'toolResponse';
  const holder = record(part[holderKey]) ? part[holderKey] as RecordValue : undefined;
  if (!holder) return undefined;
  const body = pair.response.resultInResponse && record(holder.response) ? holder.response : holder;
  if (!body) return undefined;
  const value = body[pair.response.resultKey];
  return typeof value === 'string' ? { body, key: pair.response.resultKey, value } : undefined;
}

function applyActions(payload: RecordValue, pairs: readonly Pair[], actions: Map<string, PlanAction>, head: number, tail: number): RecordValue {
  const out = clonePayload(payload);
  for (const pair of pairs) {
    const action = actions.get(pair.fingerprint);
    if (!action || action === 'keep') continue;
    const current = responseResult(out, pair);
    if (!current) continue;
    const replacement = action === 'drop_call'
      ? shortenToolResult(current.value, 0, 0)
      : shortenToolResult(current.value, head, tail);
    if (replacement.length < current.value.length) current.body[current.key] = replacement;
  }
  return out;
}

function rawContentsChars(payload: RecordValue): number {
  const contents = contentsOf(payload);
  return contents ? JSON.stringify(contents).length : 0;
}

function candidateMap(pairs: readonly Pair[]): Map<string, Pair> {
  return new Map(pairs.map((pair, index) => [`t${index + 1}`, pair]));
}

function sessionPlan(state: AgyCompactionState, sessionId: string, nextContext: string): SessionPlan {
  const previous = state.sessions.get(sessionId);
  if (previous?.contextKey === nextContext) {
    previous.touchedAt = Date.now();
    return previous;
  }
  const fresh = { contextKey: nextContext, actions: new Map<string, PlanAction>(), touchedAt: Date.now() };
  state.sessions.set(sessionId, fresh);
  if (state.sessions.size > MAX_SESSIONS) {
    const oldest = [...state.sessions.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0]?.[0];
    if (oldest && oldest !== sessionId) state.sessions.delete(oldest);
  }
  return fresh;
}

export async function compactAgyPayload(
  input: unknown,
  asker: JevAsker,
  state: AgyCompactionState,
  options: AgyCompactOptions = {},
): Promise<AgyCompactResult | undefined> {
  if (!record(input)) return undefined;
  const contents = contentsOf(input);
  const sessionId = sessionIdOf(input);
  if (!contents || !sessionId || contents.length < 2) return undefined;

  const preserveRecentMessages = Math.max(0, Math.floor(finiteOption(options.preserveRecentMessages, 6)));
  const pairs = pairRefs(contents, preserveRecentMessages);
  if (!pairs.length) return undefined;

  const plan = sessionPlan(state, sessionId, semanticContextKey(contents));
  const unplanned = pairs.filter((pair) => !pair.pinned && !plan.actions.has(pair.fingerprint));
  const minEligible = Math.max(0, Math.floor(finiteOption(options.minEligibleChars, DEFAULT_MIN_ELIGIBLE_CHARS)));
  const eligibleChars = unplanned.reduce((sum, pair) => sum + pair.response.result.length, 0);
  const beforeChars = rawContentsChars(input);
  const minimum = Math.min(1, Math.max(0, finiteOption(options.minReductionRatio, 0.15)));
  const potentialRatio = beforeChars ? eligibleChars / beforeChars : 0;
  const allowNetwork = eligibleChars >= minEligible && (plan.actions.size > 0 || potentialRatio >= minimum);

  const normalized = toMessages(contents, pairs);
  const memo = new PlanAsker(asker, candidateMap(pairs), plan.actions, allowNetwork);
  const result = await compact(normalized, memo, options);

  const proposedActions = new Map(plan.actions);
  if (memo.providerAsked && !memo.providerFailed) {
    for (const decision of result.decisions) {
      if (decision.pinned) continue;
      const pair = pairs.find((item) => item.callId === decision.callId);
      if (pair && !proposedActions.has(pair.fingerprint)) proposedActions.set(pair.fingerprint, decision.action);
    }
  }

  const head = Math.max(0, Math.floor(finiteOption(options.truncateHeadChars, 300)));
  const tail = Math.max(0, Math.floor(finiteOption(options.truncateTailChars, 100)));
  const baseline = applyActions(input, pairs, plan.actions, head, tail);
  const proposed = applyActions(input, pairs, proposedActions, head, tail);
  const proposedChars = rawContentsChars(proposed);
  const proposedReduction = beforeChars ? (beforeChars - proposedChars) / beforeChars : 0;
  const acceptedNew = !memo.providerAsked || memo.providerFailed || proposedReduction >= minimum;
  if (memo.providerAsked && !memo.providerFailed && acceptedNew) plan.actions = proposedActions;

  const output = memo.providerFailed ? input : memo.providerAsked && !acceptedNew ? baseline : proposed;
  const afterChars = rawContentsChars(output);
  const reductionRatio = beforeChars ? (beforeChars - afterChars) / beforeChars : 0;

  const pairById = new Map(pairs.map((pair) => [pair.callId, pair]));
  const effectiveDecisions = result.decisions.map((decision): CallDecision => {
    const pair = pairById.get(decision.callId);
    if (!pair) return decision;
    const current = responseResult(input, pair)?.value ?? '';
    const next = responseResult(output, pair)?.value ?? current;
    const changed = next !== current && next.length < current.length;
    return {
      ...decision,
      action: changed ? 'truncate_result' : 'keep',
      originalChars: current.length,
      savedChars: changed ? current.length - next.length : 0,
    };
  });
  const stats: CompactStats = {
    ...result.stats,
    charsBefore: beforeChars,
    charsAfter: afterChars,
    requests: memo.providerRequests,
    callsDropped: 0,
    resultsTruncated: effectiveDecisions.filter((decision) => decision.action === 'truncate_result').length,
    kept: effectiveDecisions.filter((decision) => !decision.pinned && decision.action === 'keep').length,
  };
  return {
    payload: output,
    changed: afterChars < beforeChars,
    providerAsked: memo.providerAsked,
    providerFailed: memo.providerFailed,
    planUpdated: memo.providerAsked && !memo.providerFailed && acceptedNew,
    sessionId,
    stats,
    decisions: effectiveDecisions,
    reductionRatio,
  };
}
export async function compactAgyRequest(
  body: Uint8Array,
  env: Record<string, string | undefined>,
  state: AgyCompactionState,
): Promise<AgyCompactResult | undefined> {
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(body).toString('utf8')); }
  catch { return undefined; }
  const jev = jevCompactOptions(env, 'agy');
  const settings = userSettings(env, 'agy');
  const asker = new JevClient({ ...jev, cacheStateSerialization: true } as JevClientOptions);
  return compactAgyPayload(payload, asker, state, {
    ...jev,
    minReductionRatio: settings.minReductionRatio,
    minEligibleChars: Number(env.JEVCOMP_AGY_MIN_ELIGIBLE_CHARS ?? DEFAULT_MIN_ELIGIBLE_CHARS),
  });
}
