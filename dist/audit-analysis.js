import { readHistory } from './store.js';
import { auditManifests } from './audit.js';
import { auditRoot, digest, readJson, unpackEvidence } from './audit-store.js';
import { indexTranscript, sourceRecord, blockText } from './audit-sources.js';
import { join } from 'node:path';
import { estimateTokens, shortenToolResult } from './compact.js';
import { codexCompactionReductionRatio, renderCodexCompactionSummary } from './codex-compaction.js';
export function expectedAction(decision, manifest, dropLimit, truncateLimit) {
    if (decision.pinned)
        return 'keep';
    if (![decision.dropLoss, decision.truncateLoss].every(value => Number.isFinite(value) && value >= 0 && value <= 1) || !Number.isSafeInteger(decision.resultChars) || decision.resultChars < 0)
        return undefined;
    const limit = Number(manifest.settings.lossThreshold);
    const head = Number(manifest.settings.truncateHeadChars);
    const tail = manifestTailChars(manifest);
    if (!Number.isFinite(limit) || !Number.isInteger(head))
        return undefined;
    const drop = dropLimit ?? limit, truncate = truncateLimit ?? limit;
    if (decision.truncateLoss >= truncate)
        return 'keep';
    if (decision.dropLoss < drop)
        return 'drop_call';
    const exactSavings = Number.isSafeInteger(decision.savedChars) && decision.savedChars >= 0 ? decision.savedChars : undefined;
    const canShorten = exactSavings !== undefined ? exactSavings > 0 : historicalShortenedLengthEstimate(decision.resultChars, head, tail) < decision.resultChars;
    return canShorten ? 'truncate_result' : 'keep';
}
function manifestTailChars(manifest) {
    const value = Number(manifest.settings.truncateTailChars);
    return Number.isInteger(value) && value >= 0 ? value : 0;
}
function historicalShortenedLengthEstimate(length, head, tail = 0) {
    if (length <= head + tail)
        return length;
    const omitted = Math.max(0, length - head - tail);
    const retained = Math.min(length, head) + Math.min(Math.max(0, length - head), tail);
    const separators = Number(head > 0) + Number(tail > 0);
    return retained + separators + `[jevcomp omitted ${omitted} chars; rerun tool if needed]`.length;
}
async function outputMessages(env, manifest, key) {
    const ref = manifest.references[key];
    if (!ref)
        return undefined;
    try {
        return await unpackEvidence(env, ref);
    }
    catch {
        return undefined;
    }
}
async function applicationEvidence(env, manifest, source, following) {
    if (manifest.stage !== 'result_produced')
        return 'not_applied';
    const boundary = source?.events.find(event => event.kind === 'boundary' && event.at >= manifest.startedAt && event.textHashes?.includes(manifest.outputHash ?? ''));
    if (boundary && manifest.agent === 'codex')
        return 'native_compaction_output_matched';
    if (manifest.agent === 'codex' && source?.events.some(event => event.kind === 'boundary' && event.encrypted && event.at >= manifest.startedAt))
        return 'native_boundary_encrypted_unconfirmed';
    if (manifest.agent === 'claude' && following) {
        const previousOutput = await outputMessages(env, manifest, 'output');
        const laterInput = await outputMessages(env, following, 'input');
        if (previousOutput?.length && laterInput && digest(JSON.stringify(previousOutput)) !== manifest.observedInputHash && laterInput.length >= previousOutput.length && JSON.stringify(previousOutput) === JSON.stringify(laterInput.slice(0, previousOutput.length)))
            return 'next_compaction_input_matched';
    }
    if (manifest.agent === 'agy') {
        try {
            const event = await readJson(join(auditRoot(env), 'events', `${manifest.id}.json`));
            if (event.event === 'transport_finished')
                return 'proxy_outbound_confirmed';
        }
        catch { }
    }
    if (manifest.agent === 'codex') {
        try {
            const event = await readJson(join(auditRoot(env), 'events', `${manifest.id}.json`));
            if (event.event === 'transport_finished')
                return 'transport_finished_consumption_unconfirmed';
        }
        catch { }
    }
    return 'unconfirmed';
}
function excerpts(output, head = 0, tail = 0) {
    const end = tail > 0 ? Math.max(head, output.length - tail) : output.length;
    const remainder = output.slice(head, end);
    if (remainder.length < 80)
        return [];
    const positions = [0, Math.floor(remainder.length / 3), Math.floor(remainder.length * 2 / 3), Math.max(0, remainder.length - 80)];
    return [...new Set(positions.map(position => remainder.slice(position, position + 80)).filter(part => new Set(part).size > 8))];
}
async function observations(source, manifest, decision, original, readSource) {
    if (manifest.stage !== 'result_produced')
        return { coverage: 'not_applied', eventsObserved: 0, windows: {}, matches: [], gaps: ['proposed cut was not returned'] };
    if (!source)
        return { coverage: 'unavailable', eventsObserved: 0, windows: {}, matches: [], gaps: ['continuation source unavailable'] };
    const ownBoundary = source.events.find(event => event.kind === 'boundary' && event.at >= manifest.startedAt);
    const nextBoundary = ownBoundary && source.events.find(event => event.kind === 'boundary' && event.offset > ownBoundary.offset);
    const after = source.events.filter(event => event.at > (manifest.endedAt ?? manifest.startedAt) &&
        event.evaluationId !== manifest.id &&
        (!ownBoundary || event.offset > ownBoundary.offset) &&
        (!nextBoundary || event.offset < nextBoundary.offset));
    const turns = new Set(after.filter(event => event.kind === 'assistant_message').map(event => event.id ?? event.hash)).size;
    const call = manifest.calls.find(call => call.id === decision.callId);
    const matches = after.filter(event => event.kind === 'result' &&
        (manifest.agent === 'agy' || event.id !== decision.callId) &&
        event.outputHash &&
        call?.resultHashes.includes(event.outputHash)).map(event => ({ kind: 'identical_result_reappeared', event }));
    const originalOutputs = original?.flatMap(message => message.toolResults ?? []).filter(result => result.callId === decision.callId).map(result => result.output) ?? [];
    if (originalOutputs.length && decision.action !== 'drop_call') {
        const head = decision.action === 'truncate_result' ? Number(manifest.settings.truncateHeadChars) : 0;
        const tail = decision.action === 'truncate_result' ? manifestTailChars(manifest) : 0;
        const needles = originalOutputs.flatMap(output => excerpts(output, head, tail));
        let scanned = 0;
        for (const event of after) {
            if (scanned >= 1024 * 1024 || matches.length >= 5)
                break;
            if (decision.action === 'truncate_result' && event.kind !== 'result' && !(manifest.agent === 'agy' && event.kind === 'text'))
                continue;
            if (decision.action === 'keep' && event.kind !== 'text')
                continue;
            try {
                const row = await readSource(event);
                if (decision.action === 'keep' && manifest.agent !== 'agy' && row.type !== 'assistant')
                    continue;
                const content = manifest.agent === 'claude' ? row.message?.content : row.payload?.content ?? row.payload?.output;
                let text = '';
                if (manifest.agent === 'agy') {
                    if (decision.action === 'keep')
                        text = typeof row.message?.text === 'string' ? row.message.text : '';
                    else if (decision.action === 'truncate_result')
                        text = Array.isArray(row.message?.toolResults)
                            ? row.message.toolResults.map((item) => typeof item.output === 'string' ? item.output : '').join('\n')
                            : '';
                }
                else if (decision.action === 'keep' && Array.isArray(content))
                    text = content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
                else if (decision.action === 'truncate_result' && manifest.agent === 'claude' && Array.isArray(content))
                    text = content.filter((item) => item.type === 'tool_result').map((item) => blockText(item.content)).join('\n');
                else if (decision.action === 'truncate_result')
                    text = blockText(content);
                scanned += text.length;
                if (needles.some(needle => text.includes(needle))) {
                    const kind = decision.action === 'keep'
                        ? 'kept_excerpt_explicitly_reused'
                        : manifest.agent === 'agy' && event.kind === 'text'
                            ? 'omitted_excerpt_reused_in_model_text'
                            : 'omitted_excerpt_reappeared';
                    matches.push({ kind, event });
                }
            }
            catch {
                if (!source.gaps.includes('source record unavailable during correlation'))
                    source.gaps.push('source record unavailable during correlation');
            }
        }
    }
    const windows = {};
    for (const window of [5, 10, 20])
        windows[String(window)] = turns >= window ? 'observed' : 'incomplete';
    return { coverage: source.gaps.length ? 'partial' : 'observed_until_source_end_or_boundary', eventsObserved: turns, windows, matches, gaps: source.gaps };
}
export async function analyzeAudit(env) {
    const { manifests, corrupt } = await auditManifests(env);
    const history = await readHistory(env);
    const rows = new Map(history.filter(row => row.phase === 'precompact' && row.auditId).map(row => [row.auditId, row]));
    const agyReuseCount = history.filter(row => row.host === 'agy' && row.phase === 'precompact').reduce((sum, row) => sum + (row.auditReuse?.count ?? 0), 0);
    const sources = new Map(), sourcesBySession = new Map();
    const cases = [];
    const sourceRecords = new Map();
    for (const manifest of manifests) {
        const sessionKey = `${manifest.agent}:${manifest.sessionId ?? manifest.id}:${manifest.agentId ?? ''}`;
        if (!sourcesBySession.has(sessionKey)) {
            try {
                sourcesBySession.set(sessionKey, await indexTranscript(env, manifest));
            }
            catch {
                sourcesBySession.set(sessionKey, undefined);
            }
        }
        const source = sourcesBySession.get(sessionKey);
        sources.set(manifest.id, source);
        const following = manifests.find(item => item.startedAt > manifest.startedAt && item.agent === manifest.agent && item.sessionId && item.sessionId === manifest.sessionId && item.agentId === manifest.agentId);
        const application = await applicationEvidence(env, manifest, source, following);
        const original = await outputMessages(env, manifest, 'input');
        const allDecisions = manifest.stage === 'failed' ? [] : rows.get(manifest.id)?.decisions ?? [];
        const evaluated = manifest.agent === 'agy' && manifest.decisionScope
            ? new Set(manifest.decisionScope.evaluated)
            : undefined;
        const decisions = evaluated ? allDecisions.filter((decision) => evaluated.has(decision.callId)) : allDecisions;
        for (const [ordinal, decision] of decisions.entries()) {
            const projection = manifest.agent === 'agy' ? manifest.decisionScope?.projections?.[decision.callId] : undefined;
            const selectedAction = projection?.selected ?? decision.action;
            const selectedSavedChars = projection?.selectedSavedChars;
            const selectedDecision = selectedAction === decision.action && selectedSavedChars === undefined
                ? decision
                : { ...decision, action: selectedAction, ...(Number.isSafeInteger(selectedSavedChars) && selectedSavedChars >= 0 ? { savedChars: selectedSavedChars } : {}) };
            const expected = expectedAction(selectedDecision, manifest);
            const observation = await observations(source, manifest, decision, original, event => {
                const key = `${source?.path}:${event.offset}`;
                if (!sourceRecords.has(key))
                    sourceRecords.set(key, sourceRecord(source, event));
                return sourceRecords.get(key);
            });
            const tags = [];
            if (decision.action === 'truncate_result')
                tags.push('shortened');
            if (manifest.stage === 'result_produced' && projection && projection.selected !== projection.applied)
                tags.push('host_projection');
            if (!decision.pinned && decision.truncateLoss > decision.dropLoss)
                tags.push('risk_order_inversion');
            if (!decision.pinned && Math.min(Math.abs(decision.dropLoss - Number(manifest.settings.lossThreshold)), Math.abs(decision.truncateLoss - Number(manifest.settings.lossThreshold))) <= 0.05)
                tags.push('near_threshold');
            if (observation.matches.some(match => ['identical_result_reappeared', 'omitted_excerpt_reappeared', 'omitted_excerpt_reused_in_model_text'].includes(match.kind)))
                tags.push('result_reappeared');
            if (observation.matches.some(match => match.kind === 'kept_excerpt_explicitly_reused'))
                tags.push('kept_excerpt_reused');
            if (decision.action === 'keep' && !decision.pinned && decision.originalChars > 5000)
                tags.push('large_kept');
            if (expected && expected !== selectedAction)
                tags.push('policy_mismatch');
            const stableKey = manifest.agent === 'agy' ? manifest.decisionScope?.stableKeys?.[decision.callId] : undefined;
            cases.push({ id: `${manifest.id}_${ordinal}`, evaluationId: manifest.id, callId: decision.callId, candidateId: decision.id,
                callKey: `${sessionKey}:${stableKey ?? decision.callId ?? `occurrence:${ordinal}`}`, agent: manifest.agent, tool: decision.name,
                proposedAction: selectedAction, action: manifest.stage === 'rejected' || manifest.stage === 'failed' ? 'not_applied' : decision.action,
                pinned: decision.pinned, dropLoss: decision.pinned ? null : decision.dropLoss, truncateLoss: decision.pinned ? null : decision.truncateLoss,
                ruleConforms: expected ? expected === selectedAction : null, originalChars: decision.originalChars, resultChars: decision.resultChars, savedChars: decision.savedChars,
                application, tags, observation });
        }
    }
    return { manifests, rows, cases, sources, corrupt, agyReuseCount };
}
export function auditReport(analysis, seed = 'jev-audit-v1', limit = 30) {
    const { cases, manifests, rows } = analysis;
    const captureTimes = manifests.map(item => item.beginMs + item.captureMs).filter(Number.isFinite).sort((a, b) => a - b);
    const percentile = (fraction) => captureTimes.length ? Math.round(captureTimes[Math.min(captureTimes.length - 1, Math.ceil(captureTimes.length * fraction) - 1)]) : null;
    const first = [...new Map([...cases].reverse().map(item => [item.callKey, item])).values()];
    const nonPinned = cases.filter(item => !item.pinned);
    const countActions = (items) => Object.fromEntries(['keep', 'truncate_result', 'drop_call'].map(action => [action, items.filter(item => item.proposedAction === action).length]));
    const ordered = [...cases].sort((a, b) => digest(`${seed}:${a.id}`).localeCompare(digest(`${seed}:${b.id}`)));
    const sample = [], sampled = new Set();
    const add = (item, reason) => { if (sample.length < limit && !sampled.has(item.callKey)) {
        sample.push({ id: item.id, reason });
        sampled.add(item.callKey);
    } };
    for (const item of ordered.slice(0, Math.ceil(limit * 0.2)))
        add(item, 'seeded_random');
    for (const tag of ['policy_mismatch', 'shortened', 'result_reappeared', 'near_threshold', 'risk_order_inversion', 'large_kept']) {
        let taken = 0;
        for (const item of ordered)
            if (item.tags.includes(tag) && taken < Math.ceil(limit / 6)) {
                const before = sample.length;
                add(item, tag);
                taken += sample.length - before;
            }
    }
    for (const item of ordered)
        add(item, 'seeded_random_fill');
    const eligible = nonPinned.filter(item => {
        const manifest = manifests.find(manifest => manifest.id === item.evaluationId);
        if (Number.isSafeInteger(item.savedChars) && item.savedChars >= 0)
            return item.savedChars > 0;
        return historicalShortenedLengthEstimate(item.resultChars, Number(manifest.settings.truncateHeadChars), manifestTailChars(manifest)) < item.resultChars;
    });
    return {
        schema: 1, generatedAt: new Date().toISOString(), units: { text: 'UTF-16 code units (same as compactor String.length)', continuation: 'unique assistant messages; not billed requests' },
        limitations: ['No causal attribution or optimal-policy claim', 'No character-to-token conversion', 'Reappearance is not proof of harm', 'No explicit reference is not proof of uselessness', 'Simulations use fixed original scores and snapshots'],
        coverage: { evaluations: manifests.length, corrupt: analysis.corrupt, partial: manifests.filter(item => item.gaps.length).length, pending: manifests.filter(item => item.stage === 'started').length, missingHistory: manifests.filter(item => !rows.has(item.id)).length, unavailableSources: manifests.filter(item => !analysis.sources.get(item.id)).length },
        policy: { checked: cases.filter(item => item.ruleConforms !== null).length, mismatches: cases.filter(item => item.ruleConforms === false).map(item => item.id), unknown: cases.filter(item => item.ruleConforms === null).length },
        counts: { decisions: cases.length, uniqueCalls: first.length, allEvaluations: countActions(cases), firstEvaluations: countActions(first), rejected: manifests.filter(item => item.stage === 'rejected').length },
        shorteningFunnel: { unprotected: nonPinned.length, positiveSizeSavings: eligible.length, favorableRiskPair: eligible.filter(item => item.proposedAction === 'truncate_result').length, accepted: eligible.filter(item => item.action === 'truncate_result').length, applicationObserved: eligible.filter(item => item.action === 'truncate_result' && ['native_compaction_output_matched', 'next_compaction_input_matched', 'proxy_outbound_confirmed'].includes(item.application)).length },
        riskInversions: nonPinned.filter(item => item.tags.includes('risk_order_inversion')).length,
        reappearances: { cases: cases.filter(item => item.tags.includes('result_reappeared')).length, withObservedApplication: cases.filter(item => item.tags.includes('result_reappeared') && ['native_compaction_output_matched', 'next_compaction_input_matched', 'proxy_outbound_confirmed'].includes(item.application)).length },
        application: Object.fromEntries(['not_applied', 'unconfirmed', 'transport_finished_consumption_unconfirmed', 'native_boundary_encrypted_unconfirmed', 'native_compaction_output_matched', 'next_compaction_input_matched', 'proxy_outbound_confirmed'].map(status => [status, manifests.filter(manifest => cases.some(item => item.evaluationId === manifest.id && item.application === status)).length])),
        decisionReuse: { agy: analysis.agyReuseCount },
        hostProjection: { agy: cases.filter(item => item.agent === 'agy' && item.tags.includes('host_projection')).length },
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
export async function inspectAuditCase(env, analysis, id) {
    const selected = analysis.cases.find(item => item.id === id);
    if (!selected)
        throw Error('audit case not found');
    const manifest = analysis.manifests.find(item => item.id === selected.evaluationId);
    const input = await outputMessages(env, manifest, 'input');
    const output = await outputMessages(env, manifest, 'output');
    let stateReference = manifest.references.state;
    for (const batch of manifest.batches) {
        if (!batch.questionsRef)
            continue;
        try {
            const questions = await unpackEvidence(env, batch.questionsRef);
            if (`drop_${selected.candidateId}` in questions || `truncate_${selected.candidateId}` in questions) {
                stateReference = batch.stateRef ?? stateReference;
                break;
            }
        }
        catch { }
    }
    let jevState;
    try {
        if (stateReference)
            jevState = await unpackEvidence(env, stateReference);
    }
    catch { }
    const source = analysis.sources.get(manifest.id);
    const later = [];
    for (const match of selected.observation.matches.slice(0, 3)) {
        try {
            later.push({ ...match, record: source ? await sourceRecord(source, match.event) : undefined });
        }
        catch {
            later.push({ ...match, unavailable: true });
        }
    }
    let review;
    try {
        review = await readJson(join(auditRoot(env), 'reviews', `${id}.json`));
    }
    catch { }
    const relevant = (messages) => messages?.filter(message => message.toolCalls.some(call => call.id === selected.callId) || message.toolResults?.some(result => result.callId === selected.callId));
    const callIndex = input?.findIndex(message => message.toolCalls.some(call => call.id === selected.callId)) ?? -1;
    const nearbyMessages = callIndex < 0 ? [] : input.slice(Math.max(0, callIndex - 4), callIndex).map(message => ({ role: message.role, text: message.text }));
    const jevHistory = Array.isArray(jevState?.history) ? jevState.history : [];
    const observedJevContext = jevHistory.filter((item) => JSON.stringify(item).includes(selected.candidateId)).slice(0, 5);
    const evaluation = { id: manifest.id, agent: manifest.agent, sessionId: manifest.sessionId, sessionSource: manifest.sessionSource, startedAt: manifest.startedAt, stage: manifest.stage,
        reason: manifest.reason, settings: manifest.settings, version: manifest.version, build: manifest.build, policy: manifest.policy,
        adapterPolicy: manifest.adapterPolicy, decisionScope: manifest.decisionScope, wire: manifest.wire, gaps: manifest.gaps };
    return { case: selected, evaluation, before: relevant(input), after: relevant(output), nearbyMessages, jevContext: { instructions: jevState?.context, goal: jevState?.goal, matchingEntries: observedJevContext, fullStateReference: stateReference }, later, review, evidenceAvailable: !!input && !!output,
        reviewQuestions: ['Was information needed at this point or only later?', 'Was it available elsewhere?', 'Was recovery acceptable?', 'Would the retained head and tail suffice?', 'Is there observed harm or only a hypothesis?', 'Which evidence is missing?'] };
}
export async function simulateAudit(env, analysis, dropLimit, truncateLimit, minimum) {
    for (const value of [dropLimit, truncateLimit, ...(minimum === undefined ? [] : [minimum])])
        if (!Number.isFinite(value) || value < 0 || value > 1)
            throw Error('thresholds must be between 0 and 1');
    const results = [];
    for (const manifest of analysis.manifests) {
        const input = await outputMessages(env, manifest, 'input');
        const row = analysis.rows.get(manifest.id);
        if (!input || !row?.decisions || manifest.gaps.some(gap => gap.includes('duplicate'))) {
            results.push({ id: manifest.id, status: 'insufficient_evidence' });
            continue;
        }
        const head = Number(manifest.settings.truncateHeadChars);
        const tail = manifestTailChars(manifest);
        const evaluated = manifest.agent === 'agy' && manifest.decisionScope ? new Set(manifest.decisionScope.evaluated) : undefined;
        const decisions = new Map(row.decisions.map((decision) => {
            if (manifest.agent === 'agy' && evaluated && !evaluated.has(decision.callId)) {
                const cached = manifest.decisionScope?.projections?.[decision.callId]?.selected;
                return [decision.callId, cached ?? decision.action];
            }
            return [decision.callId, expectedAction(decision, manifest, dropLimit, truncateLimit)];
        }));
        if ([...decisions.values()].some(action => !action)) {
            results.push({ id: manifest.id, status: 'unsupported_settings' });
            continue;
        }
        const proposed = input.map(message => {
            if (manifest.agent === 'agy') {
                return {
                    ...message,
                    toolCalls: message.toolCalls,
                    toolResults: message.toolResults?.map(result => {
                        const action = decisions.get(result.callId);
                        if (action !== 'drop_call' && action !== 'truncate_result')
                            return result;
                        const shortened = action === 'drop_call'
                            ? shortenToolResult(result.output, 0, 0)
                            : shortenToolResult(result.output, head, tail);
                        return shortened.length < result.output.length ? { ...result, output: shortened } : result;
                    }),
                };
            }
            return {
                ...message,
                toolCalls: message.toolCalls.filter(call => decisions.get(call.id) !== 'drop_call'),
                toolResults: message.toolResults?.filter(result => decisions.get(result.callId) !== 'drop_call').map(result => {
                    if (decisions.get(result.callId) !== 'truncate_result')
                        return result;
                    const shortened = shortenToolResult(result.output, head, tail);
                    return shortened.length < result.output.length ? { ...result, output: shortened } : result;
                }),
            };
        }).filter(message => manifest.agent === 'agy' || message.text.trim() || message.toolCalls.length || message.toolResults?.length);
        const chars = (messages) => messages.reduce((sum, message) => sum + message.text.length + message.toolCalls.reduce((n, call) => n + (typeof call.input === 'string' ? call.input : JSON.stringify(call.input) ?? String(call.input)).length, 0) + (message.toolResults ?? []).reduce((n, result) => n + result.output.length, 0), 0);
        let before = chars(input), after = chars(proposed);
        if (manifest.agent === 'agy') {
            const wireBefore = Number(manifest.settings.agyWireBeforeChars);
            const wireFixed = Number(manifest.settings.agyWireFixedChars);
            if (Number.isFinite(wireBefore) && wireBefore >= 0 && Number.isFinite(wireFixed) && wireFixed >= 0) {
                before = wireBefore;
                after = wireFixed + proposed.reduce((sum, message) => sum + (message.toolResults ?? []).reduce((n, result) => n + JSON.stringify(result.output).length, 0), 0);
            }
        }
        const reduction = manifest.agent === 'codex' ? codexCompactionReductionRatio(input, proposed) : before ? (before - after) / before : 0;
        let accepted = reduction >= (minimum ?? Number(manifest.settings.minReductionRatio));
        let rejection = accepted ? undefined : 'below_minimum';
        if (manifest.agent === 'codex') {
            const summary = renderCodexCompactionSummary(proposed);
            if (!summary.trim() || estimateTokens(summary) > Number(manifest.settings.maxSummaryTokens)) {
                accepted = false;
                rejection = 'host_output_constraint';
            }
        }
        const changedRows = row.decisions.filter((decision) => !evaluated || evaluated.has(decision.callId)).filter((decision) => {
            const observed = manifest.agent === 'agy'
                ? manifest.decisionScope?.projections?.[decision.callId]?.selected ?? decision.action
                : decision.action;
            return decisions.get(decision.callId) !== observed;
        });
        results.push({ id: manifest.id, before, after, reduction, accepted, rejection, changes: changedRows.map(decision => ({
                callId: decision.callId,
                from: manifest.agent === 'agy' ? manifest.decisionScope?.projections?.[decision.callId]?.selected ?? decision.action : decision.action,
                to: decisions.get(decision.callId),
            })) });
    }
    return { scope: 'independent original snapshots; downstream behavior is not simulated', dropLimit, truncateLimit, minimum, results };
}
