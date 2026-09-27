import { randomUUID } from 'node:crypto';
import { beginAudit } from './audit.js';
import { compactMessages, reductionRatio } from './compact.js';
import { jevCompactOptions } from './hooks.js';
import { userSettings } from './settings.js';
import { tryAppendHistory } from './store.js';
import type { Message } from './types.js';

/** Claude Code hands its transcript over from its function hook; Jev decides what the compacted conversation keeps. */
export async function compactForClaude(body: Record<string, unknown>, baseEnv: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const messages = Array.isArray(body.messages) ? body.messages as Message[] : [];
  const provider = body.provider === 'typesafe' ? 'typesafe' : body.provider === 'openrouter' ? 'openrouter' : undefined;
  const apiKey = typeof body.apiKey === 'string' && body.apiKey ? body.apiKey : undefined;
  const env = provider && apiKey ? { ...baseEnv, JEVCOMP_PROVIDER: provider, [provider === 'typesafe' ? 'TYPESAFE_API_KEY' : 'OPENROUTER_API_KEY']: apiKey } : baseEnv;
  const at = new Date().toISOString();
  const runId = randomUUID();
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
  const minimum = userSettings(env, 'claude').minReductionRatio;
  const jev = jevCompactOptions(env, 'claude');
  const audit = await beginAudit(env, 'claude', runId, messages, { minReductionRatio: minimum, provider: jev.provider, model: jev.model }, sessionId, typeof body.agentId === 'string' ? body.agentId : undefined);
  const row = { at, runId, ...(audit ? { auditId: runId } : {}), sessionId: sessionId ?? runId, trigger: typeof body.trigger === 'string' ? body.trigger : undefined, host: 'claude' as const, phase: 'precompact' as const };
  if (messages.length < 2) {
    const recorded = await tryAppendHistory({ ...row, status: 'skipped', detail: 'transcript has fewer than 2 messages' }, env);
    await audit?.finish('rejected', 'conversation_too_short', recorded);
    return { apply: false, reason: 'conversation too short' };
  }
  try {
    const result = await compactMessages(messages, { ...jev, auditObserver: audit?.observe });
    if (reductionRatio(result) < minimum) {
      const recorded = await tryAppendHistory({ ...row, provider: jev.provider, status: 'skipped', stats: result.stats, decisions: result.decisions, detail: `reduction below ${minimum}` }, env);
      await audit?.finish('rejected', 'below_minimum', recorded);
      return { apply: false, reason: `reduction below ${Math.round(minimum * 100)}%` };
    }
    const truncated: Record<string, string> = {};
    for (const message of result.messages) {
      for (const output of message.toolResults ?? []) {
        if (result.decisions.some((d) => d.callId === output.callId && d.action === 'truncate_result')) truncated[output.callId] = output.output;
      }
    }
    const recorded = await tryAppendHistory({ ...row, provider: jev.provider, status: 'prepared', stats: result.stats, decisions: result.decisions, retainedChars: result.stats.charsAfter }, env);
    const restoreRecorded = await tryAppendHistory({ ...row, at: new Date().toISOString(), phase: 'restore', status: 'restored', stats: result.stats, retainedChars: result.stats.charsAfter, injectedChars: result.stats.charsAfter, injectedPayloadChars: result.stats.charsAfter, detail: 'Claude Code kept the Jev-cut conversation instead of a summary' }, env);
    if (!restoreRecorded) audit?.manifest.gaps.push('restore history not recorded');
    const response = {
      apply: true,
      dropped: result.decisions.filter((d) => d.action === 'drop_call').map((d) => d.callId),
      truncated,
      summary: `${Math.round(reductionRatio(result) * 100)}% cut: ${result.stats.callsDropped} removed, ${result.stats.resultsTruncated} shortened`,
    };
    await audit?.finish('result_produced', 'cut_returned_to_hook', recorded, response);
    return response;
  } catch (error) {
    const recorded = await tryAppendHistory({ ...row, provider: jev.provider, status: 'failed', detail: error instanceof Error ? error.message : String(error) }, env);
    await audit?.finish('failed', 'compaction_failed', recorded);
    throw error;
  }
}
