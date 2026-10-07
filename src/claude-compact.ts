import { randomUUID } from 'node:crypto';
import { beginAudit } from './audit.js';
import { compactMessages, reductionRatio } from './compact.js';
import { assignArm, recordFallback, recordJevTokens } from './experiment.js';
import { applyJevCut, claudeMessageChars, safeJevCut, toJevMessages, type ClaudeMessage, type JevCut } from './claude.js';
import { jevCompactOptions } from './hooks.js';
import { userSettings } from './settings.js';
import { tryAppendHistory } from './store.js';
import type { Message } from './types.js';

/** Claude Code hands its transcript over from its function hook; Jev decides what the compacted conversation keeps. */
export async function compactForClaude(body: Record<string, unknown>, baseEnv: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const hostMessages = Array.isArray(body.hostMessages) ? body.hostMessages as ClaudeMessage[] : undefined;
  const messages = hostMessages ? toJevMessages(hostMessages) : Array.isArray(body.messages) ? body.messages as Message[] : [];
  const provider = body.provider === 'typesafe' ? 'typesafe' : body.provider === 'openrouter' ? 'openrouter' : undefined;
  const apiKey = typeof body.apiKey === 'string' && body.apiKey ? body.apiKey : undefined;
  const env = provider && apiKey ? { ...baseEnv, JEVCOMP_PROVIDER: provider, [provider === 'typesafe' ? 'TYPESAFE_API_KEY' : 'OPENROUTER_API_KEY']: apiKey } : baseEnv;
  const at = new Date().toISOString();
  const runId = randomUUID();
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const minimum = userSettings(env, 'claude').minReductionRatio;
  const jev = jevCompactOptions(env, 'claude');
  const measured = sessionId && messages.length >= 2 ? await assignArm(env, 'claude', sessionId) : undefined;
  if (measured?.arm === 'native') {
    await tryAppendHistory({ at, runId, sessionId: sessionId!, host: 'claude', phase: 'precompact', status: 'skipped', detail: 'gain measurement: this compaction was left to Claude Code' }, env);
    return { apply: false, reason: 'gain measurement: Claude Code compacts this time' };
  }
  const audit = await beginAudit(env, 'claude', runId, messages, { minReductionRatio: minimum, provider: jev.provider, model: jev.model }, sessionId, typeof body.agentId === 'string' ? body.agentId : undefined);
  const row = { at, runId, ...(audit ? { auditId: runId } : {}), sessionId: sessionId ?? runId, trigger: typeof body.trigger === 'string' ? body.trigger : undefined, host: 'claude' as const, phase: 'precompact' as const };
  if (messages.length < 2) {
    const recorded = await tryAppendHistory({ ...row, status: 'skipped', detail: 'transcript has fewer than 2 messages' }, env);
    await audit?.finish('rejected', 'conversation_too_short', recorded);
    return { apply: false, reason: 'conversation too short' };
  }
  try {
    const result = await compactMessages(messages, { ...jev, auditObserver: audit?.observe });
    await recordJevTokens(env, 'claude', measured?.unitId, result.stats.jevInputTokens, result.stats.jevOutputTokens);
    const truncated: Record<string, string> = {};
    for (const message of result.messages) {
      for (const output of message.toolResults ?? []) {
        if (result.decisions.some((d) => d.callId === output.callId && d.action === 'truncate_result')) truncated[output.callId] = output.output;
      }
    }
    const requestedCut: JevCut = { dropped: result.decisions.filter((d) => d.action === 'drop_call').map((d) => d.callId), truncated };
    const cut = hostMessages ? safeJevCut(hostMessages, requestedCut) : requestedCut;
    const effectiveDropped = new Set(cut.dropped);
    const decisions = result.decisions.map((decision) =>
      decision.action === 'drop_call' && !effectiveDropped.has(decision.callId)
        ? { ...decision, action: 'keep' as const, savedChars: 0 }
        : decision);
    const hostAfter = hostMessages ? applyJevCut(hostMessages, cut) : undefined;
    if (hostAfter && audit) audit.observe('output', toJevMessages(hostAfter));
    const hostBeforeChars = hostMessages ? claudeMessageChars(hostMessages) : result.stats.charsBefore;
    const hostAfterChars = hostAfter ? claudeMessageChars(hostAfter) : result.stats.charsAfter;
    const actualReduction = hostBeforeChars ? (hostBeforeChars - hostAfterChars) / hostBeforeChars : reductionRatio(result);
    const stats = {
      ...result.stats,
      charsBefore: hostBeforeChars,
      charsAfter: hostAfterChars,
      callsDropped: decisions.filter((decision) => decision.action === 'drop_call').length,
      resultsTruncated: decisions.filter((decision) => decision.action === 'truncate_result').length,
      kept: decisions.filter((decision) => !decision.pinned && decision.action === 'keep').length,
    };
    if (actualReduction <= 0 || actualReduction < minimum) {
      const reason = actualReduction <= 0 ? 'no_reduction' : 'below_minimum';
      const detail = actualReduction <= 0 ? 'host-safe cut made no reduction' : `reduction below ${minimum}`;
      const recorded = await tryAppendHistory({ ...row, provider: jev.provider, status: 'skipped', stats, decisions, detail }, env);
      await audit?.finish('rejected', reason, recorded);
      await recordFallback(env, 'claude', measured?.unitId);
      return { apply: false, reason: actualReduction <= 0 ? 'no reduction' : `reduction below ${Math.round(minimum * 100)}%` };
    }
    const recorded = await tryAppendHistory({ ...row, provider: jev.provider, status: 'prepared', stats, decisions, retainedChars: hostAfterChars }, env);
    const restoreRecorded = await tryAppendHistory({ ...row, at: new Date().toISOString(), phase: 'restore', status: 'restored', stats, retainedChars: hostAfterChars, injectedChars: hostAfterChars, injectedPayloadChars: hostAfterChars, detail: 'Claude Code kept the Jev-cut conversation instead of a summary' }, env);
    if (!restoreRecorded) audit?.manifest.gaps.push('restore history not recorded');
    const response = {
      apply: true,
      ...cut,
      summary: `${Math.round(actualReduction * 100)}% cut: ${stats.callsDropped} removed, ${stats.resultsTruncated} shortened`,
    };
    await audit?.finish('result_produced', 'cut_returned_to_hook', recorded, response);
    return response;
  } catch (error) {
    const recorded = await tryAppendHistory({ ...row, provider: jev.provider, status: 'failed', detail: error instanceof Error ? error.message : String(error) }, env);
    await audit?.finish('failed', 'compaction_failed', recorded);
    await recordFallback(env, 'claude', measured?.unitId);
    throw error;
  }
}
