import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { compactMessages, reductionRatio } from './compact.js';
import { dashboardPort, ensureDashboard } from './dashboard-service.js';
import { inspectHooks, uninstallHooks } from './install.js';
import { dedupeRetainedMessages, type DedupeSummary } from './membership.js';
import { providerConfig, resolveApiKey, resolveProvider, type JevProvider } from './provider.js';
import { userSettings } from './settings.js';
import { loadCodexRolloutSnapshot } from './rollout.js';
import { capContext, renderIndex, renderMessages, renderMessagesForInjection } from './render.js';
import { claimReady, discardPendingState, markReady, peekReady, prepareState, recordHookActivity, sweep, tryAppendHistory, type SessionState } from './store.js';
import type { CallDecision, Message } from './types.js';

interface HookInput {
  session_id: string;
  turn_id?: string;
  transcript_path?: string | null;
  hook_event_name: string;
  source?: string;
  trigger?: string;
  model?: string;
}

function num(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function numAny(env: Record<string, string | undefined>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}


function parseInput(value: unknown): HookInput {
  if (!value || typeof value !== 'object') throw new Error('invalid hook input');
  const v = value as Record<string, unknown>;
  if (typeof v.session_id !== 'string' || typeof v.hook_event_name !== 'string') throw new Error('invalid hook input');
  return {
    session_id: v.session_id,
    hook_event_name: v.hook_event_name,
    turn_id: typeof v.turn_id === 'string' ? v.turn_id : undefined,
    transcript_path: typeof v.transcript_path === 'string' || v.transcript_path === null ? v.transcript_path : undefined,
    source: typeof v.source === 'string' ? v.source : undefined,
    trigger: typeof v.trigger === 'string' ? v.trigger : undefined,
    model: typeof v.model === 'string' ? v.model : undefined,
  };
}

async function migrateLegacyHooks(input: HookInput, env: Record<string, string | undefined>): Promise<false | true | string> {
  if (!env.PLUGIN_ROOT) return false;
  const codexHome = env.CODEX_HOME ?? join(homedir(), '.codex');
  const sessionHash = createHash('sha256').update(input.session_id).digest('hex');
  const marker = join(codexHome, 'jevcomp', 'migrations', `${sessionHash}.skip`);
  if (input.hook_event_name === 'SessionStart' && input.source && input.source !== 'compact') {
    try { await rm(marker, { force: true }); }
    catch (error) { return `jevcomp could not resume plugin hooks: ${String(error)}`; }
  }
  try { await readFile(marker); return true; }
  catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
      return `jevcomp could not inspect migration state: ${String(error)}`;
    }
  }
  if (!(await inspectHooks(env)).events.length) return false;
  try {
    await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
    await writeFile(marker, '', { flag: 'wx', mode: 0o600 });
    await uninstallHooks(env);
  } catch (error) { return `jevcomp could not migrate older hooks: ${String(error)}`; }
  return true;
}

function requestedProvider(env: Record<string, string | undefined>): JevProvider | undefined {
  const value = env.JEVCOMP_PROVIDER;
  return value === 'typesafe' || value === 'openrouter' || value === 'auto' ? value : undefined;
}

function providerName(env: Record<string, string | undefined>): string {
  return resolveProvider({ provider: requestedProvider(env), env });
}

async function archivedMessages(messagesFile: string | undefined): Promise<Message[] | undefined> {
  if (messagesFile) {
    try {
      const messages = JSON.parse(await readFile(messagesFile, 'utf8')) as Message[];
      if (Array.isArray(messages)) return messages;
    } catch {}
  }
  return undefined;
}

// Codex adds its current instructions back after compaction; older copies, including our last restore, are stale.
function withoutInstructions(messages: readonly Message[]): Message[] {
  return messages.filter((message) => message.role !== 'developer' && message.role !== 'system');
}

function hasEvidence(messages: readonly Message[]): boolean {
  return messages.some((message) => message.text.trim() || message.toolCalls.length || (message.toolResults?.length ?? 0) > 0);
}

interface MembershipPlan {
  status: 'verified' | 'unavailable' | 'stale';
  messages?: Message[];
  decisions?: CallDecision[];
  nativePresentChars: number;
  restoreCandidateChars: number;
  dedupedTextItems: number;
  dedupedToolPairs: number;
}

async function membershipPlan(
  state: SessionState,
  input: HookInput,
  retainedMessages: readonly Message[] | undefined,
): Promise<MembershipPlan> {
  const fallback: MembershipPlan = {
    status: 'unavailable',
    messages: retainedMessages ? [...retainedMessages] : undefined,
    decisions: [...state.decisions],
    nativePresentChars: 0,
    restoreCandidateChars: retainedMessages ? renderMessages(retainedMessages).length : state.contextChars,
    dedupedTextItems: 0,
    dedupedToolPairs: 0,
  };
  if (!retainedMessages || !input.transcript_path || !state.transcriptPath ||
      input.transcript_path !== state.transcriptPath || !Number.isFinite(state.transcriptBytesAtScore)) return fallback;

  try {
    const live = await loadCodexRolloutSnapshot(input.transcript_path);
    // The compacted checkpoint must have been appended at or after the byte position
    // observed by PreCompact. Otherwise this can only be an older/stale checkpoint.
    if (live.checkpointOffset === undefined || live.checkpointOffset < (state.transcriptBytesAtScore ?? Number.MAX_SAFE_INTEGER)) {
      return { ...fallback, status: 'stale' };
    }
    const deduped: DedupeSummary = dedupeRetainedMessages(retainedMessages, live.messages, state.decisions);
    return {
      status: 'verified',
      messages: deduped.messages,
      decisions: deduped.decisions,
      nativePresentChars: deduped.nativePresentChars,
      restoreCandidateChars: deduped.missingRenderChars,
      dedupedTextItems: deduped.textItemsAlreadyPresent,
      dedupedToolPairs: deduped.toolPairsAlreadyPresent,
    };
  } catch {
    // Dedupe is an optimization. Any parsing/schema/I/O uncertainty must preserve
    // the old behavior rather than suppress retained context.
    return fallback;
  }
}

function renderRestorePayload(
  mode: 'preserve' | 'balanced' | 'minimal',
  messages: readonly Message[] | undefined,
  decisions: readonly CallDecision[],
  storedIndex: string,
  fallbackContext: string,
  indexMaxChars: number,
): string {
  if (messages && !hasEvidence(messages)) return '';
  const full = messages ? renderMessagesForInjection(messages) : fallbackContext;
  const index = messages ? renderIndex(messages, decisions, indexMaxChars) : storedIndex;
  if (mode === 'preserve') return full;
  if (mode === 'balanced') return full ? `${index}\n\nSelected evidence excerpt:\n${capContext(full, 12_000)}` : index;
  return index;
}

async function restore(input: HookInput, event: 'SessionStart' | 'UserPromptSubmit', env: Record<string, string | undefined>): Promise<Record<string, unknown>> {
  const ttl = Math.max(0, num(env, 'JEVCOMP_RESTORE_TTL_MS', 86_400_000));
  const preview = await peekReady(input.session_id, ttl, env);
  if (!preview) return { continue: true, suppressOutput: true };

  const settings = userSettings(env, 'codex');
  const restoreMode = settings.restoreMode;
  const cap = settings.restoreMaxChars;
  let retainedMessages: Message[] | undefined;
  let fallbackContext = '';
  try {
    const archived = await archivedMessages(preview.messagesFile);
    retainedMessages = archived && withoutInstructions(archived);
    fallbackContext = retainedMessages
      ? renderMessagesForInjection(retainedMessages)
      : await readFile(preview.contextFile, 'utf8');
  } catch (error) {
    await tryAppendHistory({
      at: new Date().toISOString(), runId: preview.runId ?? preview.createdAt,
      sessionId: input.session_id, turnId: input.turn_id, phase: 'restore', status: 'failed',
      stats: preview.stats,
      detail: `restore archive unavailable: ${error instanceof Error ? error.message : String(error)}`,
    }, env);
    return { continue: true, suppressOutput: true };
  }

  const membership = await membershipPlan(preview, input, retainedMessages);
  const selectedMessages = membership.messages ?? retainedMessages;
  const selectedDecisions = membership.decisions ?? preview.decisions;
  let payload = renderRestorePayload(
    restoreMode,
    selectedMessages,
    selectedDecisions,
    preview.index,
    fallbackContext,
    numAny(env, ['JEVCOMP_INDEX_MAX_CHARS', 'JEVCOMP_INDEX_CHARS'], 12_000),
  );
  // A single setting means one thing in every restore mode: maximum evidence payload.
  if (cap > 0) payload = capContext(payload, cap);

  // Consume only after archives are readable and the optional membership check finished.
  // expectedCreatedAt prevents a delayed hook from claiming a newer compaction state.
  const state = await claimReady(input.session_id, ttl, env, preview.createdAt);
  if (!state) return { continue: true, suppressOutput: true };

  const membershipDetail = membership.status === 'verified'
    ? `exact post-compaction dedupe removed ${membership.nativePresentChars} retained chars already present in Codex`
    : membership.status === 'stale'
      ? 'post-compaction checkpoint not newer than PreCompact snapshot; conservative full restore used'
      : 'post-compaction membership unavailable; conservative full restore used';

  const header = restoreMode === 'preserve'
    ? `Codex compacted this session. Jev selected useful pre-compaction evidence. ${membership.status === 'verified' ? 'Only selected evidence not already present verbatim after native compaction is injected below.' : 'Selected retained context is injected below.'} Very large individual results may be head/tail abridged in the injected payload, while the full retained normalized archive remains on disk. Missing tool calls were judged stale and can be rerun.`
    : restoreMode === 'balanced'
      ? `Codex compacted this session. Jev selected useful pre-compaction evidence. ${membership.status === 'verified' ? 'A compact index plus bounded excerpts are built only from selected evidence still missing verbatim after native compaction.' : 'A compact index plus a bounded evidence excerpt is injected below.'} The full retained normalized archive remains on disk.`
      : `Codex compacted this session. Jev selected useful pre-compaction evidence. ${membership.status === 'verified' ? 'The compact index contains only selected evidence still missing verbatim after native compaction.' : 'A compact index is injected below.'} The full retained normalized archive remains on disk.`;
  const structured = state.messagesFile ? `\nStructured retained messages: ${state.messagesFile}` : '';
  const injected = payload
    ? `${header}\n\n${payload}\n\nFull retained context: ${state.contextFile}${structured}`
    : '';

  const commonHistory = {
    at: new Date().toISOString(),
    runId: state.runId ?? state.createdAt,
    sessionId: input.session_id,
    turnId: input.turn_id,
    phase: 'restore' as const,
    stats: state.stats,
    restoreMode,
    restoreLimitChars: cap,
    retainedChars: state.contextChars,
    nativePresentChars: membership.nativePresentChars,
    restoreCandidateChars: membership.restoreCandidateChars,
    membershipStatus: membership.status,
    dedupedTextItems: membership.dedupedTextItems,
    dedupedToolPairs: membership.dedupedToolPairs,
  };

  if (!payload) {
    await tryAppendHistory({
      ...commonHistory,
      status: 'restored',
      injectedChars: 0,
      injectedPayloadChars: 0,
      detail: `nothing missing after native compaction; ${membershipDetail}`,
    }, env);
    return { continue: true, suppressOutput: true };
  }

  await tryAppendHistory({
    ...commonHistory,
    status: 'restored',
    injectedChars: injected.length,
    injectedPayloadChars: payload.length,
    detail: membershipDetail,
  }, env);
  return {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: { hookEventName: event, additionalContext: injected },
  };
}

async function dashboardNotice(env: Record<string, string | undefined>, options: HookOptions): Promise<string | undefined> {
  if (!options.startDashboard) return undefined;
  try { return `jevcomp dashboard: ${await ensureDashboard(dashboardPort(env), env)}`; }
  catch (error) { return `jevcomp dashboard unavailable: ${error instanceof Error ? error.message : String(error)}`; }
}

export interface HookOptions { startDashboard?: boolean }

/** Jev settings shared by the Codex hooks and the dashboard's compaction for Claude Code. */
export function jevCompactOptions(env: Record<string, string | undefined>) {
  const provider = resolveProvider({ provider: requestedProvider(env), env });
  const transport = providerConfig({ provider, env });
  const settings = userSettings(env, 'codex');
  return {
    provider,
    env,
    model: transport.model,
    goal: env.JEVCOMP_GOAL,
    baseUrl: transport.baseUrl,
    lossThreshold: settings.lossThreshold,
    preserveRecentMessages: settings.pinRecentMessages,
    maxStateTokens: Math.max(1_000, num(env, 'JEVCOMP_MAX_STATE_TOKENS', 24_000)),
    maxRequestTokens: Math.max(2_000, num(env, 'JEVCOMP_MAX_REQUEST_TOKENS', 30_000)),
    truncateHeadChars: Math.max(0, num(env, 'JEVCOMP_TRUNCATE_HEAD_CHARS', 300)),
    maxConcurrentRequests: Math.max(1, num(env, 'JEVCOMP_CONCURRENCY', 4)),
    timeoutMs: Math.max(1, num(env, 'JEVCOMP_TIMEOUT_MS', 20_000)),
    retries: Math.max(0, num(env, 'JEVCOMP_RETRIES', 1)),
  };
}

const FUNCTION_HOOKS_FLAG = 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS';

/** Plugins cannot set environment variables, and Claude Code reads this one only at startup, from the user's settings. */
export async function enableFunctionHooks(env: Record<string, string | undefined>): Promise<string> {
  const path = join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json');
  try {
    let settings: Record<string, unknown> = {};
    try { settings = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('not a JSON object');
    const current = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env as Record<string, unknown> : {};
    if (current[FUNCTION_HOOKS_FLAG] !== '1') {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify({ ...settings, env: { ...current, [FUNCTION_HOOKS_FLAG]: '1' } }, null, 2)}\n`);
    }
    return `jevcomp turned on Claude Code function hooks in ${path}. Restart Claude Code to start using jevcomp.`;
  } catch {
    return `jevcomp is off: add "${FUNCTION_HOOKS_FLAG}": "1" under "env" in ${path} and restart Claude Code.`;
  }
}

async function claudeHook(input: HookInput, env: Record<string, string | undefined>, options: HookOptions): Promise<Record<string, unknown>> {
  if (input.hook_event_name !== 'SessionStart' || (input.source !== 'startup' && input.source !== 'resume')) return { continue: true, suppressOutput: true };
  const notices: string[] = [];
  if (env[FUNCTION_HOOKS_FLAG] !== '1') notices.push(await enableFunctionHooks(env));
  // Claude Code exports the plugin's own key option to hook processes; the dashboard gets it from the module instead.
  if (!env.CLAUDE_PLUGIN_OPTION_APIKEY && !resolveApiKey(resolveProvider({ provider: requestedProvider(env), env }), { env })) notices.push('jevcomp needs an API key: set OPENROUTER_API_KEY or TYPESAFE_API_KEY, or fill it in the plugin options.');
  const dashboard = await dashboardNotice(env, options);
  if (dashboard) notices.push(dashboard);
  return notices.length ? { continue: true, systemMessage: notices.join(' · ') } : { continue: true, suppressOutput: true };
}

export async function handleHook(value: unknown, env: Record<string, string | undefined> = process.env, options: HookOptions = {}): Promise<Record<string, unknown>> {
  const input = parseInput(value);
  // Claude Code compacts through the plugin's function hook; its command hooks only start the dashboard.
  if (env.CLAUDE_PLUGIN_ROOT && !env.PLUGIN_ROOT) return claudeHook(input, env, options);
  if (options.startDashboard) await recordHookActivity(input.hook_event_name, env).catch(() => {});
  const migration = await migrateLegacyHooks(input, env);
  if (typeof migration === 'string') return { continue: true, systemMessage: migration };
  if (migration) return { continue: true, suppressOutput: true };
  if (input.hook_event_name === 'SessionStart' && input.source !== 'compact') {
    const notices: string[] = [];
    const provider = resolveProvider({ provider: requestedProvider(env), env });
    if (env.PLUGIN_ROOT && !resolveApiKey(provider, { env })) notices.push('jevcomp needs an API key. Open the plugin and choose Configure with OpenRouter or TypeSafe.');
    const dashboard = await dashboardNotice(env, options);
    if (dashboard && (input.source === 'startup' || input.source === 'resume')) notices.push(dashboard);
    if (notices.length) return { continue: true, systemMessage: notices.join(' · ') };
  }
  if (input.hook_event_name === 'UserPromptSubmit') await dashboardNotice(env, options);
  if (input.hook_event_name === 'PreCompact') {
    const createdAt = new Date().toISOString();
    const runId = `${input.session_id}:${input.turn_id ?? 'compact'}:${createdAt}`;
    await discardPendingState(input.session_id, env);
    if (!input.transcript_path) {
      await tryAppendHistory({ at: new Date().toISOString(), runId, sessionId: input.session_id, turnId: input.turn_id, trigger: input.trigger, model: input.model, provider: providerName(env), phase: 'precompact', status: 'failed', detail: 'transcript path unavailable' }, env);
      return { continue: true, systemMessage: 'jevcomp: Codex did not share this conversation, so it compacts without jevcomp' };
    }
    try {
      await sweep(env, num(env, 'JEVCOMP_STATE_MAX_AGE_MS', 48 * 60 * 60 * 1000));
      const rollout = await loadCodexRolloutSnapshot(input.transcript_path);
      const messages = rollout.messages;
      if (messages.length < 2) {
        await tryAppendHistory({ at: new Date().toISOString(), runId, sessionId: input.session_id, turnId: input.turn_id, trigger: input.trigger, model: input.model, provider: providerName(env), phase: 'precompact', status: 'skipped', detail: 'transcript has fewer than 2 messages' }, env);
        return { continue: true, suppressOutput: true };
      }
      const jev = jevCompactOptions(env);
      const provider = jev.provider;
      const result = await compactMessages(messages, jev);
      const minimum = userSettings(env, 'codex').minReductionRatio;
      if (reductionRatio(result) < minimum) {
        await tryAppendHistory({ at: new Date().toISOString(), runId, sessionId: input.session_id, turnId: input.turn_id, trigger: input.trigger, model: input.model, provider, phase: 'precompact', status: 'skipped', stats: result.stats, decisions: result.decisions, detail: `reduction below ${minimum}` }, env);
        return { continue: true, suppressOutput: true };
      }
      const prepared = await prepareState(
        {
          sessionId: input.session_id,
          turnId: input.turn_id,
          trigger: input.trigger,
          model: input.model,
          transcriptPath: input.transcript_path,
          transcriptBytesAtScore: rollout.fileBytes,
          createdAt,
          runId,
          stats: result.stats,
          decisions: result.decisions,
          index: renderIndex(result.messages, result.decisions, numAny(env, ['JEVCOMP_INDEX_MAX_CHARS', 'JEVCOMP_INDEX_CHARS'], 12_000)),
        },
        renderMessages(result.messages),
        env,
        result.messages,
      );
      await tryAppendHistory({
        at: new Date().toISOString(), runId, sessionId: input.session_id, turnId: input.turn_id,
        trigger: input.trigger, model: input.model, provider,
        phase: 'precompact', status: 'prepared', stats: result.stats, decisions: result.decisions,
        retainedChars: prepared.contextChars,
      }, env);
      return { continue: true, systemMessage: `jevcomp: kept what still matters from old command and file output (${Math.round(reductionRatio(result) * 100)}% cut: ${result.stats.callsDropped} removed, ${result.stats.resultsTruncated} shortened)` };
    } catch (error) {
      await tryAppendHistory({ at: new Date().toISOString(), runId, sessionId: input.session_id, turnId: input.turn_id, trigger: input.trigger, model: input.model, provider: providerName(env), phase: 'precompact', status: 'failed', detail: error instanceof Error ? error.message : String(error) }, env);
      return { continue: true, systemMessage: `jevcomp: Codex compacted without jevcomp (${error instanceof Error ? error.message : String(error)})` };
    }
  }
  if (input.hook_event_name === 'PostCompact') {
    try {
      const state = await markReady(input.session_id, input.turn_id, env);
      if (state) await tryAppendHistory({ at: new Date().toISOString(), runId: state.runId ?? state.createdAt, sessionId: input.session_id, turnId: input.turn_id, trigger: input.trigger, model: input.model, provider: providerName(env), phase: 'postcompact', status: 'ready', stats: state.stats }, env);
    } catch {
      // Compaction already succeeded. A sidecar persistence failure must not abort Codex.
    }
    return { continue: true, suppressOutput: true };
  }
  if (input.hook_event_name === 'SessionStart' && input.source === 'compact') return restore(input, 'SessionStart', env);
  if (input.hook_event_name === 'UserPromptSubmit') return restore(input, 'UserPromptSubmit', env);
  return { continue: true, suppressOutput: true };
}
