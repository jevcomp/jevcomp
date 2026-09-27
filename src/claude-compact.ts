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
  const row = { at, runId: `claude:${at}`, sessionId: typeof body.sessionId === 'string' ? body.sessionId : 'claude', trigger: typeof body.trigger === 'string' ? body.trigger : undefined, host: 'claude' as const, phase: 'precompact' as const };
  if (messages.length < 2) {
    await tryAppendHistory({ ...row, status: 'skipped', detail: 'transcript has fewer than 2 messages' }, env);
    return { apply: false, reason: 'conversation too short' };
  }
  const jev = jevCompactOptions(env);
  try {
    const result = await compactMessages(messages, jev);
    const minimum = userSettings(env, 'claude').minReductionRatio;
    if (reductionRatio(result) < minimum) {
      await tryAppendHistory({ ...row, provider: jev.provider, status: 'skipped', stats: result.stats, decisions: result.decisions, detail: `reduction below ${minimum}` }, env);
      return { apply: false, reason: `reduction below ${Math.round(minimum * 100)}%` };
    }
    const truncated: Record<string, string> = {};
    for (const message of result.messages) {
      for (const output of message.toolResults ?? []) {
        if (result.decisions.some((d) => d.callId === output.callId && d.action === 'truncate_result')) truncated[output.callId] = output.output;
      }
    }
    await tryAppendHistory({ ...row, provider: jev.provider, status: 'prepared', stats: result.stats, decisions: result.decisions, retainedChars: result.stats.charsAfter }, env);
    await tryAppendHistory({ ...row, at: new Date().toISOString(), phase: 'restore', status: 'restored', stats: result.stats, retainedChars: result.stats.charsAfter, injectedChars: result.stats.charsAfter, injectedPayloadChars: result.stats.charsAfter, detail: 'Claude Code kept the Jev-cut conversation instead of a summary' }, env);
    return {
      apply: true,
      dropped: result.decisions.filter((d) => d.action === 'drop_call').map((d) => d.callId),
      truncated,
      summary: `${Math.round(reductionRatio(result) * 100)}% cut: ${result.stats.callsDropped} removed, ${result.stats.resultsTruncated} shortened`,
    };
  } catch (error) {
    await tryAppendHistory({ ...row, provider: jev.provider, status: 'failed', detail: error instanceof Error ? error.message : String(error) }, env);
    throw error;
  }
}
