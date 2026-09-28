import { compact, shortenToolResult } from './compact.js';
import { digest } from './audit-store.js';
import { JevClient } from './provider.js';
import { jevCompactOptions } from './hooks.js';
import { userSettings } from './settings.js';
const DEFAULT_MIN_ELIGIBLE_CHARS = 2_000;
const MAX_SESSIONS = 64;
function record(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function strings(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
export function createAgyCompactionState() {
    return { sessions: new Map() };
}
function requestOf(payload) {
    return record(payload.request) ? payload.request : undefined;
}
function contentsOf(payload) {
    const request = requestOf(payload);
    return Array.isArray(request?.contents) ? request.contents : undefined;
}
function plainText(content) {
    if (!record(content) || !Array.isArray(content.parts))
        return '';
    return content.parts.flatMap((part) => {
        if (!record(part) || part.thought === true || typeof part.text !== 'string')
            return [];
        return [part.text];
    }).join('\n');
}
function goalKey(contents) {
    const recent = contents.flatMap((content) => {
        if (!record(content) || content.role !== 'user')
            return [];
        const text = plainText(content).trim();
        return text ? [text] : [];
    }).slice(-3);
    return digest(JSON.stringify(recent));
}
function collectRefs(contents) {
    const calls = [];
    const responses = [];
    contents.forEach((content, contentIndex) => {
        if (!record(content) || !Array.isArray(content.parts))
            return;
        content.parts.forEach((part, partIndex) => {
            if (!record(part))
                return;
            if (record(part.functionCall)) {
                const call = part.functionCall;
                const name = strings(call.name);
                if (name)
                    calls.push({ contentIndex, partIndex, name, id: strings(call.id), value: call });
            }
            if (record(part.functionResponse)) {
                const response = part.functionResponse;
                const name = strings(response.name);
                const body = record(response.response) ? response.response : undefined;
                if (name && body && typeof body.result === 'string') {
                    responses.push({ contentIndex, partIndex, name, id: strings(response.id), value: response, result: body.result });
                }
            }
        });
    });
    return { calls, responses };
}
function location(ref) {
    return ref.contentIndex * 1_000_000 + ref.partIndex;
}
function pairRefs(contents, preserveRecentMessages) {
    const { calls, responses } = collectRefs(contents);
    const callIdCounts = new Map();
    const responseIdCounts = new Map();
    for (const call of calls)
        if (call.id)
            callIdCounts.set(call.id, (callIdCounts.get(call.id) ?? 0) + 1);
    for (const response of responses)
        if (response.id)
            responseIdCounts.set(response.id, (responseIdCounts.get(response.id) ?? 0) + 1);
    const usedCalls = new Set();
    const provisional = [];
    for (const response of responses.sort((a, b) => location(a) - location(b))) {
        let matches = [];
        if (response.id && callIdCounts.get(response.id) === 1 && responseIdCounts.get(response.id) === 1) {
            matches = calls.filter((call) => call.id === response.id && location(call) < location(response) && !usedCalls.has(call));
        }
        else if (!response.id) {
            matches = calls.filter((call) => call.name === response.name && location(call) < location(response) && !usedCalls.has(call));
        }
        if (matches.length !== 1)
            continue;
        usedCalls.add(matches[0]);
        provisional.push({ call: matches[0], response });
    }
    provisional.sort((a, b) => location(a.call) - location(b.call));
    const seen = new Map();
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
function toMessages(contents, pairs) {
    const callsByContent = new Map();
    const responsesByContent = new Map();
    for (const pair of pairs) {
        callsByContent.set(pair.call.contentIndex, [...(callsByContent.get(pair.call.contentIndex) ?? []), pair]);
        responsesByContent.set(pair.response.contentIndex, [...(responsesByContent.get(pair.response.contentIndex) ?? []), pair]);
    }
    return contents.map((content, index) => {
        const role = record(content) && content.role === 'model' ? 'assistant' : 'user';
        const calls = callsByContent.get(index) ?? [];
        const responses = responsesByContent.get(index) ?? [];
        return {
            role,
            text: plainText(content),
            toolCalls: calls.map((pair) => ({
                id: pair.callId,
                name: pair.call.name,
                input: record(pair.call.value.args) ? pair.call.value.args : pair.call.value.args ?? {},
            })),
            ...(responses.length ? { toolResults: responses.map((pair) => ({ callId: pair.callId, output: pair.response.result })) } : {}),
        };
    });
}
function plannedAnswer(action, kind) {
    if (action === 'keep')
        return 1;
    if (action === 'truncate_result')
        return kind === 'drop' ? 1 : 0;
    return 0;
}
class PlanAsker {
    delegate;
    pairsByCandidate;
    actions;
    allowNetwork;
    providerAsked = false;
    providerFailed = false;
    constructor(delegate, pairsByCandidate, actions, allowNetwork) {
        this.delegate = delegate;
        this.pairsByCandidate = pairsByCandidate;
        this.actions = actions;
        this.allowNetwork = allowNetwork;
    }
    async ask(state, questions) {
        const answers = {};
        const external = {};
        for (const [key, question] of Object.entries(questions)) {
            const candidate = record(question.instructions) ? strings(question.instructions.candidate) : undefined;
            const pair = candidate ? this.pairsByCandidate.get(candidate) : undefined;
            const action = pair ? this.actions.get(pair.fingerprint) : undefined;
            if (action) {
                answers[key] = { noul: plannedAnswer(action, key.startsWith('drop_') ? 'drop' : 'truncate') };
            }
            else if (!this.allowNetwork) {
                answers[key] = { noul: 1 };
            }
            else {
                external[key] = question;
            }
        }
        if (!Object.keys(external).length)
            return { answers };
        this.providerAsked = true;
        try {
            const response = await this.delegate.ask(state, external);
            return { ...response, answers: { ...answers, ...response.answers } };
        }
        catch {
            this.providerFailed = true;
            for (const key of Object.keys(external))
                answers[key] = { noul: 1 };
            return { answers };
        }
    }
}
function clonePayload(payload) {
    return JSON.parse(JSON.stringify(payload));
}
function responseResult(payload, pair) {
    const contents = contentsOf(payload);
    const content = contents?.[pair.response.contentIndex];
    if (!record(content) || !Array.isArray(content.parts))
        return undefined;
    const part = content.parts[pair.response.partIndex];
    if (!record(part) || !record(part.functionResponse) || !record(part.functionResponse.response))
        return undefined;
    const value = part.functionResponse.response.result;
    return typeof value === 'string' ? { body: part.functionResponse.response, value } : undefined;
}
function applyActions(payload, pairs, actions, head, tail) {
    const out = clonePayload(payload);
    for (const pair of pairs) {
        const action = actions.get(pair.fingerprint);
        if (!action || action === 'keep')
            continue;
        const current = responseResult(out, pair);
        if (!current)
            continue;
        const replacement = action === 'drop_call'
            ? shortenToolResult(current.value, 0, 0)
            : shortenToolResult(current.value, head, tail);
        if (replacement.length < current.value.length)
            current.body.result = replacement;
    }
    return out;
}
function rawContentsChars(payload) {
    const contents = contentsOf(payload);
    return contents ? JSON.stringify(contents).length : 0;
}
function candidateMap(pairs) {
    return new Map(pairs.map((pair, index) => [`t${index + 1}`, pair]));
}
function sessionPlan(state, sessionId, nextGoal) {
    const previous = state.sessions.get(sessionId);
    if (previous?.goalKey === nextGoal) {
        previous.touchedAt = Date.now();
        return previous;
    }
    const fresh = { goalKey: nextGoal, actions: new Map(), touchedAt: Date.now() };
    state.sessions.set(sessionId, fresh);
    if (state.sessions.size > MAX_SESSIONS) {
        const oldest = [...state.sessions.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0]?.[0];
        if (oldest && oldest !== sessionId)
            state.sessions.delete(oldest);
    }
    return fresh;
}
export async function compactAgyPayload(input, asker, state, options = {}) {
    if (!record(input))
        return undefined;
    const request = requestOf(input);
    const contents = contentsOf(input);
    const sessionId = strings(request?.sessionId);
    if (!request || !contents || !sessionId || contents.length < 2)
        return undefined;
    const preserveRecentMessages = Math.max(0, Math.floor(options.preserveRecentMessages ?? 6));
    const pairs = pairRefs(contents, preserveRecentMessages);
    if (!pairs.length)
        return undefined;
    const plan = sessionPlan(state, sessionId, goalKey(contents));
    const unplanned = pairs.filter((pair) => !pair.pinned && !plan.actions.has(pair.fingerprint));
    const minEligible = Math.max(0, Math.floor(options.minEligibleChars ?? DEFAULT_MIN_ELIGIBLE_CHARS));
    const eligibleChars = unplanned.reduce((sum, pair) => sum + pair.response.result.length, 0);
    const beforeChars = rawContentsChars(input);
    const minimum = Math.min(1, Math.max(0, options.minReductionRatio ?? 0.15));
    const potentialRatio = beforeChars ? eligibleChars / beforeChars : 0;
    const allowNetwork = eligibleChars >= minEligible && (plan.actions.size > 0 || potentialRatio >= minimum);
    const normalized = toMessages(contents, pairs);
    const memo = new PlanAsker(asker, candidateMap(pairs), plan.actions, allowNetwork);
    const result = await compact(normalized, memo, options);
    const proposedActions = new Map(plan.actions);
    if (memo.providerAsked && !memo.providerFailed) {
        for (const decision of result.decisions) {
            if (decision.pinned)
                continue;
            const pair = pairs.find((item) => item.callId === decision.callId);
            if (pair && !proposedActions.has(pair.fingerprint))
                proposedActions.set(pair.fingerprint, decision.action);
        }
    }
    const head = Math.max(0, Math.floor(options.truncateHeadChars ?? 300));
    const tail = Math.max(0, Math.floor(options.truncateTailChars ?? 100));
    const baseline = applyActions(input, pairs, plan.actions, head, tail);
    const proposed = applyActions(input, pairs, proposedActions, head, tail);
    const proposedChars = rawContentsChars(proposed);
    const proposedReduction = beforeChars ? (beforeChars - proposedChars) / beforeChars : 0;
    const acceptedNew = !memo.providerAsked || memo.providerFailed || proposedReduction >= minimum;
    if (memo.providerAsked && !memo.providerFailed && acceptedNew)
        plan.actions = proposedActions;
    const output = memo.providerAsked && !memo.providerFailed && !acceptedNew ? baseline : proposed;
    const afterChars = rawContentsChars(output);
    const reductionRatio = beforeChars ? (beforeChars - afterChars) / beforeChars : 0;
    const pairById = new Map(pairs.map((pair) => [pair.callId, pair]));
    const effectiveDecisions = result.decisions.map((decision) => {
        const pair = pairById.get(decision.callId);
        if (!pair)
            return decision;
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
    const stats = {
        ...result.stats,
        charsBefore: beforeChars,
        charsAfter: afterChars,
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
export async function compactAgyRequest(body, env, state) {
    let payload;
    try {
        payload = JSON.parse(Buffer.from(body).toString('utf8'));
    }
    catch {
        return undefined;
    }
    const jev = jevCompactOptions(env, 'agy');
    const settings = userSettings(env, 'agy');
    const asker = new JevClient({ ...jev, cacheStateSerialization: true });
    return compactAgyPayload(payload, asker, state, {
        ...jev,
        minReductionRatio: settings.minReductionRatio,
        minEligibleChars: Number(env.JEVCOMP_AGY_MIN_ELIGIBLE_CHARS ?? DEFAULT_MIN_ELIGIBLE_CHARS),
    });
}
