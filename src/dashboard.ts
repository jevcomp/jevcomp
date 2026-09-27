import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { applySettingsChange, settingsSnapshot } from './dashboard-settings.js';
import { readableHistoryPaths, readHistory, type HistoryRow } from './store.js';
import { settingsPath, userSettings } from './settings.js';
import type { CallDecision } from './types.js';
import { VERSION } from './version.js';

interface ToolSummary {
  tool: string;
  calls: number;
  kept: number;
  dropped: number;
  truncated: number;
  originalChars: number;
  removedChars: number;
}

interface RunSummary {
  runId: string;
  at: string;
  sessionId: string;
  trigger?: string;
  model?: string;
  provider?: string;
  host: 'codex' | 'claude' | 'agy';
  status: 'prepared' | 'ready' | 'restored' | 'nothing_missing' | 'skipped' | 'too_short' | 'failed' | 'restore_failed';
  reductionRatio: number;
  charsBefore: number;
  charsAfter: number;
  removedChars: number;
  calls: number;
  kept: number;
  truncated: number;
  dropped: number;
  pinned: number;
  jevRequests: number;
  jevInputTokens: number;
  jevOutputTokens: number;
  jevUsageReportedRequests: number;
  selectionMs: number;
  injectedPayloadChars?: number;
  retainedChars?: number;
  detail?: string;
}

/** Blocks keep transcript order, oldest first, so the chart reads left to right like the conversation. */
interface LastCompaction {
  at: string;
  host: 'codex' | 'claude' | 'agy';
  status: RunSummary['status'];
  charsBefore: number;
  injectedPayloadChars: number;
  blocks: { tool: string; label: string; decision: DecisionCode; chars: number }[];
}

type DecisionCode = 'k' | 's' | 'r' | 'p';

function decisionCode(decision: CallDecision): DecisionCode {
  if (decision.pinned) return 'p';
  return decision.action === 'drop_call' ? 'r' : decision.action === 'truncate_result' ? 's' : 'k';
}

const FILE_READERS = new Set(['cat', 'type', 'get-content', 'gc', 'head', 'tail', 'less', 'more', 'nl']);
const SEARCHERS = new Set(['rg', 'grep', 'select-string', 'findstr', 'ag', 'ack']);

/** Tells a layperson what kind of step it was, from the command's first word or the tool's name. */
function commandKind(tool: string, label: string): string {
  const words = label.trim().split(/\s+/);
  const first = words[0]?.toLowerCase() ?? '';
  const name = tool.toLowerCase();
  if (FILE_READERS.has(first) || (first === 'sed' && words.includes('-n')) || /read|view/.test(name)) return 'leitura de arquivo';
  if (SEARCHERS.has(first) || (first === 'git' && words[1] === 'grep') || /search|grep|find/.test(name)) return 'busca';
  return 'comando';
}

// Previews are cut at a fixed length, so the JSON is often incomplete and has to be read field by field.
function commandLabel(tool: string, preview: string | undefined): string {
  const text = preview ?? '';
  for (const field of ['cmd', 'command', 'file_path', 'path', 'pattern', 'query']) {
    const match = new RegExp(`(?:^|[{,\\s])"?${field}"?\\s*:\\s*(\\[\\s*)?"((?:[^"\\\\]|\\\\.)*)`).exec(text);
    if (match?.[2]) return match[2].replace(/\\(["\\/])/g, '$1');
  }
  return text.trim() || tool;
}

function positive(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

function ratio(removed: number, before: number): number {
  return before > 0 ? removed / before : 0;
}

function runKey(row: HistoryRow): string {
  return row.runId ?? `${row.sessionId}:${row.turnId ?? ''}:${row.at}`;
}

/** Build only measured statistics. No chars/4 or claimed Codex billing-token savings. */
export async function stats(env = process.env, agent?: 'codex' | 'claude' | 'agy') {
  const rows = (await readHistory(env)).filter((row) => !agent || (row.host ?? 'codex') === agent);
  const prepared = rows.filter((r) => r.status === 'prepared' && r.stats);
  const skipped = rows.filter((r) => r.status === 'skipped' && r.phase !== 'restore');
  const precompactFailures = rows.filter((r) => r.status === 'failed' && (r.phase === 'precompact' || !r.phase));
  const restoreFailures = rows.filter((r) => r.status === 'failed' && r.phase === 'restore');
  const ready = rows.filter((r) => r.status === 'ready' && r.stats);
  const restored = rows.filter((r) => r.status === 'restored' && r.stats);
  const restoredRunKeys = new Set(restored.map(runKey));
  const completedPrepared = prepared.filter((r) => restoredRunKeys.has(runKey(r)));

  const transcriptCharsBefore = prepared.reduce((n, r) => n + positive(r.stats?.charsBefore), 0);
  const transcriptCharsAfter = prepared.reduce((n, r) => n + positive(r.stats?.charsAfter), 0);
  const transcriptCharsRemoved = Math.max(0, transcriptCharsBefore - transcriptCharsAfter);
  const completedCharsBefore = completedPrepared.reduce((n, r) => n + positive(r.stats?.charsBefore), 0);
  const completedCharsAfter = completedPrepared.reduce((n, r) => n + positive(r.stats?.charsAfter), 0);
  const completedCharsRemoved = Math.max(0, completedCharsBefore - completedCharsAfter);
  const retainedArchiveChars = prepared.reduce((n, r) => n + positive(r.retainedChars ?? r.stats?.charsAfter), 0);
  const injectedChars = restored.reduce((n, r) => n + positive(r.injectedChars), 0);
  const injectedPayloadChars = restored.reduce((n, r) => n + positive(r.injectedPayloadChars), 0);
  const restoreEligibleChars = restored.reduce((n, r) => n + positive(r.retainedChars), 0);
  const restoreCharsNotInjected = Math.max(0, restoreEligibleChars - injectedPayloadChars);
  // A skip happens after Jev has already judged the transcript, so its provider
  // usage is real cost even though no retained sidecar is applied.
  const scored = [...prepared, ...skipped].filter((r) => r.stats);
  const jevInputTokens = scored.reduce((n, r) => n + positive(r.stats?.jevInputTokens), 0);
  const jevOutputTokens = scored.reduce((n, r) => n + positive(r.stats?.jevOutputTokens), 0);
  const jevRequests = scored.reduce((n, r) => n + positive(r.stats?.requests), 0);
  const jevUsageReportedRequests = scored.reduce((n, r) => {
    const stats = r.stats;
    if (!stats) return n;
    const explicit = stats.jevUsageReportedRequests;
    if (Number.isFinite(explicit)) return n + positive(explicit);
    return n + ((positive(stats.jevInputTokens) + positive(stats.jevOutputTokens)) > 0 ? positive(stats.requests) : 0);
  }, 0);
  const selectionMs = scored.reduce((n, r) => n + positive(r.stats?.ms), 0);

  const byTool = new Map<string, ToolSummary>();
  // Tool-level "removed" figures should represent runs that actually made it
  // through restore, not merely a prepared sidecar that native compaction or
  // the process lifecycle never consumed.
  for (const row of completedPrepared) {
    for (const decision of row.decisions ?? []) {
      const current = byTool.get(decision.name) ?? { tool: decision.name, calls: 0, kept: 0, dropped: 0, truncated: 0, originalChars: 0, removedChars: 0 };
      current.calls++;
      current.kept += Number(decision.action === 'keep');
      current.dropped += Number(decision.action === 'drop_call');
      current.truncated += Number(decision.action === 'truncate_result');
      current.originalChars += positive(decision.originalChars);
      current.removedChars += positive(decision.savedChars);
      byTool.set(decision.name, current);
    }
  }

  const recentDecisions = prepared
    .slice()
    .reverse()
    .flatMap((row) => (row.decisions ?? []).slice().reverse().map((decision) => ({
      at: row.at,
      sessionId: row.sessionId,
      tool: decision.name,
      inputPreview: decision.inputPreview,
      action: decision.action,
      removedChars: positive(decision.savedChars),
      originalChars: positive(decision.originalChars),
      dropLoss: decision.dropLoss,
      truncateLoss: decision.truncateLoss,
      pinned: decision.pinned,
      decision: decisionCode(decision),
      label: commandLabel(decision.name, decision.inputPreview),
      kind: commandKind(decision.name, commandLabel(decision.name, decision.inputPreview)),
    })))
    .slice(0, 100);

  const readyByRun = new Map<string, HistoryRow>();
  for (const row of ready) readyByRun.set(runKey(row), row);
  const restoresByRun = new Map<string, HistoryRow>();
  for (const row of restored) restoresByRun.set(runKey(row), row);
  const restoreFailuresByRun = new Map<string, HistoryRow>();
  for (const row of restoreFailures) restoreFailuresByRun.set(runKey(row), row);
  const runs: RunSummary[] = [];
  for (const row of [...prepared, ...skipped, ...precompactFailures]) {
    const s = row.stats;
    const before = positive(s?.charsBefore);
    const after = positive(s?.charsAfter);
    const key = runKey(row);
    const restore = restoresByRun.get(key);
    const restoreFailure = restoreFailuresByRun.get(key);
    const readyRow = readyByRun.get(key);
    runs.push({
      runId: key,
      at: row.at,
      sessionId: row.sessionId,
      trigger: row.trigger,
      model: row.model,
      provider: row.provider,
      host: row.host ?? 'codex',
      status: row.status === 'prepared'
        ? restore ? (positive(restore.injectedPayloadChars) > 0 ? 'restored' : 'nothing_missing') : restoreFailure ? 'restore_failed' : readyRow ? 'ready' : 'prepared'
        : row.status === 'skipped' && !row.stats ? 'too_short' : row.status as RunSummary['status'],
      reductionRatio: ratio(Math.max(0, before - after), before),
      charsBefore: before,
      charsAfter: after,
      removedChars: Math.max(0, before - after),
      calls: positive(s?.calls),
      kept: positive(s?.kept),
      truncated: positive(s?.resultsTruncated),
      dropped: positive(s?.callsDropped),
      pinned: positive(s?.pinned),
      jevRequests: positive(s?.requests),
      jevInputTokens: positive(s?.jevInputTokens),
      jevOutputTokens: positive(s?.jevOutputTokens),
      jevUsageReportedRequests: Number.isFinite(s?.jevUsageReportedRequests) ? positive(s?.jevUsageReportedRequests) : ((positive(s?.jevInputTokens) + positive(s?.jevOutputTokens)) > 0 ? positive(s?.requests) : 0),
      selectionMs: positive(s?.ms),
      injectedPayloadChars: restore?.injectedPayloadChars,
      retainedChars: restore?.retainedChars ?? row.retainedChars,
      detail: restoreFailure?.detail ?? row.detail,
    });
  }
  runs.sort((a, b) => b.at.localeCompare(a.at));
  const runStatusCounts: Partial<Record<RunSummary['status'], number>> = {};
  for (const run of runs) runStatusCounts[run.status] = (runStatusCounts[run.status] ?? 0) + 1;

  const newestOf = (rows: HistoryRow[]) => rows.reduce<HistoryRow | undefined>((last, row) => !last || row.at > last.at ? row : last, undefined);
  const latest = newestOf(prepared.filter((row) => restoredRunKeys.has(runKey(row)))) ?? newestOf(prepared);
  const lastCompaction: LastCompaction | null = latest ? {
    at: latest.at,
    host: latest.host ?? 'codex',
    status: runs.find((run) => run.runId === runKey(latest))?.status ?? 'prepared',
    charsBefore: positive(latest.stats?.charsBefore),
    injectedPayloadChars: positive(restoresByRun.get(runKey(latest))?.injectedPayloadChars),
    blocks: (latest.decisions ?? []).map((decision) => ({
      tool: decision.name,
      label: commandLabel(decision.name, decision.inputPreview),
      decision: decisionCode(decision),
      chars: positive(decision.originalChars),
    })),
  } : null;

  return {
    measured: true,
    note: 'Primary context-reduction figures are measured from local transcript characters. Jev token usage is reported by the Jev provider. Codex billing-token savings are not inferred.',
    attempts: prepared.length + skipped.length + precompactFailures.length,
    prepared: prepared.length,
    ready: ready.length,
    restored: restored.length,
    latestRestoredAt: restored.reduce((latest, row) => row.at > latest ? row.at : latest, ''),
    skipped: skipped.length,
    nativeFallbacks: precompactFailures.length,
    restoreFailures: restoreFailures.length,
    transcriptCharsBefore,
    transcriptCharsAfter,
    transcriptCharsRemoved,
    transcriptReductionRatio: ratio(transcriptCharsRemoved, transcriptCharsBefore),
    completedCharsBefore,
    completedCharsAfter,
    completedCharsRemoved,
    completedReductionRatio: ratio(completedCharsRemoved, completedCharsBefore),
    retainedArchiveChars,
    injectedChars,
    injectedPayloadChars,
    restoreEligibleChars,
    restoreCharsNotInjected,
    jevInputTokens,
    jevOutputTokens,
    jevRequests,
    jevUsageReportedRequests,
    jevUsageCoverage: jevRequests ? jevUsageReportedRequests / jevRequests : 0,
    evaluatedSelections: scored.length,
    averageSelectionMs: scored.length ? Math.round(selectionMs / scored.length) : 0,
    settings: userSettings(env, 'codex'),
    byTool: [...byTool.values()].sort((a, b) => b.removedChars - a.removedChars),
    recentDecisions,
    runs: runs.slice(0, 100),
    runStatusCounts,
    lastCompaction,
    recentEvents: rows.slice(-100).reverse(),
  };
}

function page(token: string, platform: string): string {
  const system = platform === 'win32' ? 'do Windows' : 'do sistema';
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="jevcomp-token" content="${token}"><meta name="jevcomp-system" content="${system}">
<title>jevcomp · dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap">
<style>
:root{
  --ground:#f3f5f1;--surface:#ffffff;--raised:#eef2ec;--line:#d9e0d8;--text:#16201a;--muted:#5d6b61;
  --accent:#1f8a4c;--accent-soft:#e2f3e8;--amber:#9a6a0f;--amber-soft:#f7ecd4;--coral:#b8482a;--coral-soft:#f8e3dc;--steel:#3563b8;--steel-soft:#e3eafa;
  --kept:#1f8a4c;--short:#c79a2b;--removed:#c9d1c8;--removed-focus:#9aa59c;--pinned:#6f5ba8;
  --sans:"Onest",ui-sans-serif,system-ui,"Segoe UI",sans-serif;--mono:"JetBrains Mono",ui-monospace,"Cascadia Code",Consolas,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;
  --ground:#101412;--surface:#171c19;--raised:#1e2521;--line:#2a332d;--text:#e9efe9;--muted:#8e9b92;
  --accent:#7ad69a;--accent-soft:#1b3325;--amber:#e8b457;--amber-soft:#3a2f18;--coral:#ef7d5d;--coral-soft:#3a221b;--steel:#8fb3f0;--steel-soft:#1f2940;
  --kept:#7ad69a;--short:#e8b457;--removed:#39443d;--removed-focus:#7d8982;--pinned:#b39ce8}}
:root[data-theme="dark"]{color-scheme:dark;
  --ground:#101412;--surface:#171c19;--raised:#1e2521;--line:#2a332d;--text:#e9efe9;--muted:#8e9b92;
  --accent:#7ad69a;--accent-soft:#1b3325;--amber:#e8b457;--amber-soft:#3a2f18;--coral:#ef7d5d;--coral-soft:#3a221b;--steel:#8fb3f0;--steel-soft:#1f2940;
  --kept:#7ad69a;--short:#e8b457;--removed:#39443d;--removed-focus:#7d8982;--pinned:#b39ce8}
*{box-sizing:border-box}[hidden]{display:none!important}
body{margin:0;background:var(--ground);color:var(--text);font:14px/1.55 var(--sans)}
h1,h2,h3,p{margin:0}h2{font-size:17px;font-weight:650;letter-spacing:-.01em;text-wrap:balance}h3{font-size:14px;font-weight:600}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
.shell{max-width:1120px;margin:auto;padding-inline:24px}
.topbar{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;padding-block:24px 14px}
.top-right{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.brand{display:flex;align-items:baseline;gap:12px}.brand b{font-family:var(--mono);font-size:18px;letter-spacing:-.02em}.brand span{font-size:12px;color:var(--muted)}
.nav{display:flex;gap:4px;border-bottom:1px solid var(--line)}
.nav button{all:unset;cursor:pointer;padding:10px 14px;color:var(--muted);font-weight:500;border-bottom:2px solid transparent;margin-bottom:-1px}
.nav button:hover{color:var(--text)}
.nav button[aria-selected="true"]{color:var(--text);border-bottom-color:var(--accent)}
.nav button:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid var(--steel);outline-offset:2px}
.content{padding-block:24px 64px;min-width:0}
.view{display:grid;gap:22px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:20px;min-width:0}
.muted{color:var(--muted)}.small{font-size:12px}
.error{font-size:13px;color:var(--coral);background:var(--coral-soft);border-radius:10px;padding:10px 14px;margin-bottom:18px}
.empty{padding:18px 0 4px;color:var(--muted);font-size:13px}
.tape-head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:baseline}
.chips{display:flex;gap:8px;flex-wrap:wrap}.chips [data-focus]{cursor:default}
.tape-wrap{position:relative}
.tape{display:flex;gap:2px;height:42px;margin-top:18px;border-radius:8px;overflow:hidden}
.tape i{display:block;height:100%;flex:1 1 0;min-width:1px;cursor:help;transition:opacity .15s}
.tape .k{background:var(--kept)}.tape .s{background:var(--short)}.tape .r{background:var(--removed)}.tape .p{background:var(--pinned);min-width:12px}
.tape[data-focus] i{opacity:.2}
.tape[data-focus="k"] i.k,.tape[data-focus="s"] i.s,.tape[data-focus="r"] i.r,.tape[data-focus="p"] i.p{opacity:1}
.tape[data-focus="r"] i.r{background:var(--removed-focus)}
.tape i.active{filter:brightness(1.25)}
.tape-tip{position:absolute;bottom:calc(100% + 8px);transform:translateX(-50%);background:var(--text);color:var(--ground);border-radius:8px;padding:7px 10px;font-size:12px;line-height:1.4;white-space:nowrap;pointer-events:none;box-shadow:0 4px 14px rgb(0 0 0 / .3);z-index:2}
.tape-tip b{font-family:var(--mono);font-weight:600}
.tape-axis{display:flex;justify-content:space-between;gap:12px;font-size:11px;color:var(--muted);margin-top:6px}
.sent{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:14px;align-items:center;margin-top:18px;padding-top:16px;border-top:1px solid var(--line);font-size:13px}
.sent-label{color:var(--muted)}.sent-bar{height:8px;border-radius:4px;background:var(--raised);overflow:hidden}.sent-bar i{display:block;height:100%;background:var(--steel)}
.sep{color:var(--muted);font-size:10px;margin:0 -2px}.pill .sep{color:inherit;opacity:.6;margin:0 2px}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.kpi{display:grid;gap:4px}.kpi .label{font-size:12px;color:var(--muted)}.kpi .value{font-family:var(--mono);font-size:28px;font-weight:700;letter-spacing:-.03em}
.kpi .value.accent{color:var(--accent)}.kpi .hint{font-size:12px;color:var(--muted)}
.flow{display:grid;gap:14px}
.flow-steps{display:grid;grid-template-columns:1fr auto 1fr auto 1fr;gap:10px}.flow-steps.two{grid-template-columns:1fr auto 1fr}
.flow-step{display:grid;gap:4px;align-content:start;background:var(--raised);border-radius:10px;padding:14px}.flow-step .label,.flow-step .hint{font-size:12px;color:var(--muted)}.flow-step b{font-size:22px;font-weight:700}
.flow-arrow{display:grid;justify-items:center;align-content:center;gap:4px;min-width:96px}.flow-arrow>span:first-child{color:var(--muted);font-size:18px}
.flow-note{font-size:11px;color:var(--muted);text-align:center;line-height:1.35;max-width:100px}.flow-note b{color:var(--coral);font-weight:600}
.flow-foot{padding-top:14px;border-top:1px solid var(--line)}
.table{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{font-size:11px;color:var(--muted);font-weight:500;text-align:left;padding:0 10px 10px}
td{padding:11px 10px;border-top:1px solid var(--line);vertical-align:middle}
.mini{display:flex;height:6px;width:140px;border-radius:3px;overflow:hidden;background:var(--raised)}
.mini i{display:block;background:var(--accent)}
.cut-text{font-size:12px;color:var(--muted);white-space:nowrap}.cut-text b{color:var(--text);font-weight:600}
table.rb th,table.rb td{white-space:nowrap}table.rb .rb-grow{width:100%}
.rb-bar{height:10px;min-width:160px}.rb-bar .before{display:block;height:100%;background:color-mix(in srgb,var(--muted) 45%,var(--surface));border-radius:4px;overflow:hidden}.rb-bar .after{display:block;height:100%;background:var(--accent)}
.rb-cut{font-size:12px;color:var(--accent)}
.decisions-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap}
.filters button{font-size:12px;padding:5px 11px}
.cmd{font-family:var(--mono);font-size:12.5px;display:block;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cmd-kind{display:block;font-size:11px;color:var(--muted);margin-top:2px}
.right{text-align:right}
.risk{display:flex;align-items:center;gap:8px}.risk-bar{width:70px;height:6px;border-radius:3px;background:var(--raised);overflow:hidden}.risk-bar i{display:block;height:100%;background:var(--steel)}
.pill{display:inline-block;font-size:12px;font-weight:600;border:1px solid color-mix(in srgb,currentColor 35%,transparent);border-radius:5px;padding:1px 7px;white-space:nowrap}.pill[title]{cursor:help}
.pill.ok{color:var(--accent);background:var(--accent-soft)}.pill.skip{color:var(--steel);background:var(--steel-soft)}.pill.fail{color:var(--coral);background:var(--coral-soft)}
.pill.wait{color:var(--amber);background:var(--amber-soft)}
.pill.short{color:var(--short);background:color-mix(in srgb,var(--short) 20%,transparent)}
.pill.drop{color:var(--muted);background:var(--removed)}
.pill.pin{color:var(--pinned);background:color-mix(in srgb,var(--pinned) 20%,transparent)}
.settings{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.55fr);gap:18px;align-items:start}
.groups{display:grid;gap:18px}
.group{padding:6px 20px 12px}
.group-head{padding:16px 0 4px;display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap}
.setting{display:grid;gap:8px;padding:16px 0}.setting + .setting{border-top:1px solid var(--line)}
.setting p{font-size:13px;color:var(--muted);max-width:68ch}
.setting .control{justify-self:start;margin-top:4px}
.seg{display:inline-flex;flex-wrap:wrap;gap:2px;padding:3px;border-radius:10px;background:var(--raised)}
.seg button{all:unset;cursor:pointer;padding:6px 12px;border-radius:8px;font-size:13px;font-weight:500;color:var(--muted);white-space:nowrap}
.seg button:hover{color:var(--text)}
.seg button[aria-pressed="true"]{background:var(--surface);color:var(--text);box-shadow:0 1px 2px rgb(0 0 0 / .12),inset 0 0 0 1px var(--line)}
.seg.numbers button{font-family:var(--mono);font-size:12px}
.seg[aria-disabled="true"]{opacity:.5}.seg[aria-disabled="true"] button{cursor:not-allowed}
.note{grid-column:1/-1;font-size:12px;color:var(--amber);background:var(--amber-soft);border-radius:8px;padding:8px 10px}
.btn{all:unset;cursor:pointer;font-size:13px;font-weight:600;padding:7px 13px;border-radius:9px;background:var(--raised);color:var(--text)}
.btn:hover{box-shadow:inset 0 0 0 1px var(--line)}
.btn.primary{background:var(--accent);color:var(--ground)}
.btn.quiet{background:none;color:var(--coral)}
.key-form{display:grid;gap:8px}
.key-form input{min-width:0;font:13px var(--mono);color:var(--text);background:var(--ground);border:1px solid var(--line);border-radius:9px;padding:8px 11px}
.key-actions{display:flex;gap:8px;flex-wrap:wrap}
.info{display:flex;justify-content:space-between;gap:12px;padding:12px 0;font-size:13px}.info + .info{border-top:1px solid var(--line)}.info span:first-child{color:var(--muted)}.info b{font-weight:600;text-align:right;overflow-wrap:anywhere}
.conn-body{margin-top:12px}.conn-note{font-size:12px;color:var(--muted);line-height:1.5;margin:6px 0 10px}.conn-note.warn{color:var(--amber)}.info .none{color:var(--muted);font-weight:500}
.confirm{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px;color:var(--muted)}
.toast{position:fixed;right:24px;bottom:calc(24px + env(safe-area-inset-bottom,0px));background:var(--text);color:var(--ground);border-radius:10px;padding:9px 15px;font-weight:600;font-size:13px}
.toast.bad{background:var(--coral);color:var(--ground)}
@media (max-width:1000px){.settings{grid-template-columns:1fr}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:760px){.shell{padding-inline:16px}.group{padding-inline:16px}.flow-steps{grid-template-columns:1fr}.flow-arrow>span:first-child{transform:rotate(90deg)}}
</style></head><body>
<div class="shell">
 <header class="topbar"><div class="brand"><b>jevcomp</b><span>compactação</span></div><div class="top-right"><div class="seg" id="agent-switch" role="group" aria-label="Agente" hidden><button type="button" data-agent="codex" aria-pressed="false">Codex</button><button type="button" data-agent="claude" aria-pressed="false">Claude Code</button><button type="button" data-agent="agy" aria-pressed="false">Antigravity</button></div><span class="small muted" id="live">dados locais</span></div></header>
 <nav class="nav" role="tablist" aria-label="Seções"><button role="tab" id="nav-geral" aria-controls="view-geral" aria-selected="true">Resumo</button><button role="tab" id="nav-config" aria-controls="view-config" aria-selected="false">Configurações</button></nav>
 <main class="content">
  <div id="error"></div>
  <section class="view" id="view-geral" role="tabpanel" aria-labelledby="nav-geral">
   <div class="kpis" id="kpis"></div>
   <div class="card"><div class="tape-head"><h2 id="last-title">Última compactação</h2><div class="chips" id="last-legend"></div></div><div id="last-run"></div></div>
   <div class="card flow"><h2>Todas as compactações</h2><div id="flow"></div><p class="flow-foot small muted" id="flow-foot">O Jev escolhe o que guardar da conversa para o Codex continuar depois da compactação.</p></div>
   <div class="card"><h2>Compactações recentes</h2><div class="table" style="margin-top:12px"><table class="rb"><thead><tr><th>Quando</th><th>Resultado</th><th class="rb-grow">Texto antes → depois do corte</th><th class="right">Antes</th><th class="right">Depois</th><th class="right">Redução</th></tr></thead><tbody id="runs"></tbody></table></div></div>
   <div class="card">
    <div class="decisions-head"><h2>Decisões recentes</h2>
     <div class="seg filters" role="group" aria-label="Filtrar decisões"><button type="button" data-filter="all" aria-pressed="true">Todas</button><button type="button" data-filter="k" aria-pressed="false">Inteiros</button><button type="button" data-filter="s" aria-pressed="false">Resumidos</button><button type="button" data-filter="r" aria-pressed="false">Removidos</button></div></div>
    <div class="table" style="margin-top:12px"><table><thead><tr><th>Quando</th><th>Comando</th><th>Decisão</th><th>Risco se descartar</th><th class="right">Saída</th><th class="right">Cortado</th></tr></thead><tbody id="decisions"></tbody></table></div>
   </div>
  </section>
  <section class="view" id="view-config" role="tabpanel" aria-labelledby="nav-config" hidden>
   <div class="settings">
    <div class="groups">
     <div class="card group"><div class="group-head"><h2>Conexão</h2><span class="small muted">Quem decide o que guardar</span></div>
      <div class="setting"><h3>Provedor</h3><p>OpenRouter e TypeSafe usam o mesmo modelo Jev. Escolha aquele em que você tem conta.</p><div id="connection" class="control"></div></div></div>
     <div id="agents-info" style="display:contents"></div>
    </div>
    <div class="groups">
     <div class="card group"><div class="group-head"><h2>Comportamento</h2><span class="small muted" id="behavior-sub">Cada mudança é salva na hora</span></div>
      <div id="behavior"></div>
      <div class="setting" id="reset-area"><h3>Voltar ao padrão</h3><p>Desfaz as mudanças acima. Provedor e chave continuam como estão.</p><div class="control"></div></div>
     </div>
    </div>
   </div>
  </section>
 </main>
</div>
<div class="toast" id="toast" role="status" hidden></div>
<script>
const token=document.querySelector('meta[name="jevcomp-token"]').content;
const SYSTEM=document.querySelector('meta[name="jevcomp-system"]').content;
const $=s=>document.querySelector(s);
const f=n=>Number(n||0).toLocaleString('pt-BR');
const pct=n=>(Number(n||0)*100).toLocaleString('pt-BR',{minimumFractionDigits:1,maximumFractionDigits:1})+'%';
const chars=n=>f(n)+' caracteres';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=s=>new Date(s);
const time=s=>date(s).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
const day=s=>date(s).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'});
const stamp=s=>day(s)+' '+time(s);
const shortStamp=s=>date(s).toDateString()===new Date().toDateString()?time(s):stamp(s);
const plural=(n,one,many)=>f(n)+' '+(n===1?one:many);
let toastTimer;
function toast(text,bad){const el=$('#toast');el.textContent=text;el.className='toast'+(bad?' bad':'');el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{el.hidden=true},2200)}

const DECISION={k:['ok','Inteiro'],s:['short','Resumido'],r:['drop','Removido'],p:['pin','Recente']};
const STATUS={restored:['ok','Enviado ao Codex','O Codex recebeu o que o resumo perdeu.'],nothing_missing:['skip','Não enviado: resumo já completo','O resumo do Codex já tinha tudo o que o Jev guardou; não havia o que enviar.'],skipped:['skip','Não enviado: pouco a cortar','Quase tudo ainda era útil: o corte ficaria abaixo do mínimo escolhido em Configurações.'],too_short:['skip','Não enviado: pouco a cortar','A conversa tinha menos de duas mensagens; não havia o que cortar.'],failed:['fail','Não enviado: erro','O jevcomp teve um erro antes da compactação e o Codex fez o resumo normal.'],restore_failed:['fail','Falha ao enviar','O jevcomp não conseguiu ler o que tinha guardado.'],ready:['wait','Aguardando envio','Vai junto do próximo prompt ou do início da próxima sessão.'],prepared:['wait','Aguardando a compactação','O Jev já escolheu; o Codex ainda está resumindo.']};
const HOST={codex:'Codex',claude:'Claude Code',agy:'Antigravity'};
const agentList=s=>[...new Set((s.runs||[]).map(r=>'o '+(HOST[r.host]||'Codex')))];
const agents=s=>agentList(s).join(' e ')||'o Codex';
const agentVerb=(s,one,many)=>agentList(s).length>1?many:one;
const CLAUDE_STATUS={restored:['ok','Cortado pelo Jev','O Claude Code ficou com a conversa cortada pelo Jev no lugar do resumo.']};
const statusPill=r=>{const claude=r.host==='claude';const[cls,label,help]=((claude&&CLAUDE_STATUS[r.status])||STATUS[r.status]||STATUS.prepared).map(t=>{t=t.replace('Codex',HOST[r.host]||'Codex');return claude?t.replace('Não enviado','Sem corte'):t});const detail=r.status==='failed'&&r.detail?help+' Motivo: '+r.detail:help;return '<span class="pill '+cls+'" title="'+esc(detail)+'">'+label+'</span>'};
const decisionPill=k=>'<span class="pill '+DECISION[k][0]+'">'+DECISION[k][1]+'</span>';

let lastRun=null,lastRunJson='',tapeFocus=null,tapeSegs=[];
function tapeSegments(blocks,width){
 const size=b=>Math.max(1,b.chars),total=blocks.reduce((n,b)=>n+size(b),0)||1,segs=[];
 for(let i=0;i<blocks.length;){
  let j=i;while(j<blocks.length&&blocks[j].decision===blocks[i].decision)j++;
  const run=blocks.slice(i,j),px=run.reduce((n,b)=>n+size(b),0)/total*width;
  if(run.length>1&&px/run.length<6)segs.push({decision:run[0].decision,chars:run.reduce((n,b)=>n+b.chars,0),count:run.length});
  else run.forEach(b=>segs.push({decision:b.decision,chars:b.chars,count:1,label:b.label}));
  i=j;
 }
 return segs;
}
function renderLastRun(last){
 const json=JSON.stringify(last);
 if(json===lastRunJson)return;
 lastRunJson=json;lastRun=last;
 if(!last){$('#last-title').textContent='Última compactação';$('#last-legend').innerHTML='';$('#last-run').innerHTML='<p class="empty">Ainda não houve compactação com o Jev.</p>';return}
 $('#last-title').textContent='Última compactação · '+stamp(last.at);
 const count=k=>last.blocks.filter(b=>b.decision===k).length;
 $('#last-legend').innerHTML=Object.entries(DECISION).map(([k,[cls,label]])=>'<span class="pill '+cls+'" data-focus="'+k+'">'+label+' <span class="sep">·</span> '+count(k)+'</span>').join('');
 tapeSegs=tapeSegments(last.blocks,$('#last-run').clientWidth||1000);
 const blocks=tapeSegs.map((g,i)=>'<i class="'+g.decision+'" style="flex-grow:'+Math.max(1,g.chars)+'" data-i="'+i+'"></i>').join('');
 const tape=last.blocks.length?'<div class="tape-wrap"><div class="tape-tip" hidden></div><div class="tape" role="img" aria-label="Saídas de comandos e leituras de arquivo da última compactação, coloridas pela decisão do Jev"'+(tapeFocus?' data-focus="'+tapeFocus+'"':'')+(tapeSegs.length>120?' style="gap:1px"':'')+'>'+blocks+'</div></div><div class="tape-axis"><span>← mais antigo</span><span>cada bloco é um comando; a largura é o tamanho da saída · passe o mouse para ver qual</span><span>mais recente →</span></div>':'<p class="empty">Nenhum comando ou leitura de arquivo nesta compactação.</p>';
 const sent=last.status==='restored'
  ?'<span class="sent-bar"><i style="width:'+Math.max(1,Math.min(100,last.injectedPayloadChars/Math.max(1,last.charsBefore)*100))+'%"></i></span><span class="num">'+f(last.injectedPayloadChars)+' de '+chars(last.charsBefore)+'</span>'
  :'<span></span>'+statusPill(last);
 $('#last-run').innerHTML=tape+'<div class="sent"><span class="sent-label">'+(last.host==='claude'?'Conversa que ficou no Claude Code depois do corte':'Enviado ao '+(HOST[last.host]||'Codex')+' depois da compactação')+'</span>'+sent+'</div>';
}
function setTapeFocus(k){tapeFocus=k;const tape=$('.tape');if(!tape)return;if(k)tape.dataset.focus=k;else delete tape.dataset.focus}
$('#last-legend').addEventListener('mouseover',e=>{const tag=e.target.closest('[data-focus]');if(tag)setTapeFocus(tag.dataset.focus)});
$('#last-legend').addEventListener('mouseleave',()=>setTapeFocus(null));
function clearTape(){const wrap=$('.tape-wrap');if(!wrap)return;wrap.querySelector('.tape-tip').hidden=true;wrap.querySelectorAll('.tape i.active').forEach(i=>i.classList.remove('active'))}
$('#last-run').addEventListener('mousemove',e=>{
 const block=e.target.closest('.tape i'),wrap=$('.tape-wrap');
 if(!wrap||!lastRun)return;
 clearTape();
 if(!block)return;
 const g=tapeSegs[Number(block.dataset.i)],tip=wrap.querySelector('.tape-tip'),decided=DECISION[g.decision][1].toLowerCase();
 block.classList.add('active');
 tip.innerHTML=g.count>1?'<b>'+g.count+' comandos</b><br>'+chars(g.chars)+' · '+decided+'s':'<b>'+esc(g.label.slice(0,90))+'</b><br>'+chars(g.chars)+' · '+decided;
 tip.hidden=false;
 const area=wrap.getBoundingClientRect(),box=block.getBoundingClientRect(),half=tip.offsetWidth/2;
 tip.style.left=Math.min(Math.max(box.left+box.width/2-area.left,half),area.width-half)+'px';
});
$('#last-run').addEventListener('mouseleave',clearTape);
addEventListener('resize',()=>{if(lastRun){lastRunJson='';renderLastRun(lastRun)}});

function kpi(label,value,hint,accent){return '<div class="card kpi"><span class="label">'+label+'</span><span class="value'+(accent?' accent':'')+'">'+value+'</span><span class="hint">'+hint+'</span></div>'}
function renderKpis(s){
 const c=s.runStatusCounts||{},n=k=>c[k]||0;
 const claude=agent==='claude';
 const parts=[[n('restored'),claude?'cortada':'com envio',claude?'cortadas':'com envio'],[n('nothing_missing')+n('skipped')+n('too_short'),claude?'sem corte':'não enviada',claude?'sem corte':'não enviadas'],[n('failed')+n('restore_failed'),'com erro','com erro'],[n('prepared')+n('ready'),'aguardando','aguardando']].filter(p=>p[0]>0).map(p=>plural(p[0],p[1],p[2]));
 $('#kpis').innerHTML=[
  kpi('Redução média',s.restored?pct(s.completedReductionRatio):'—',s.restored?'nas '+plural(s.restored,'compactação','compactações')+' em que o Jev cortou':'ainda sem compactação concluída',true),
  kpi('Compactações',f(s.attempts),parts.join(' · ')||'nenhuma ainda'),
  kpi('Chamadas ao Jev',f(s.jevRequests),s.jevUsageReportedRequests?f(s.jevInputTokens)+' tokens de entrada':'o provedor não informou os tokens'),
  kpi('Texto retirado',s.restored?f(s.completedCharsRemoved):'—','caracteres que '+agents(s)+' '+agentVerb(s,'deixou','deixaram')+' de carregar a cada nova mensagem')
 ].join('');
}
function renderFlow(s){
 const hosts=[...new Set((s.runs||[]).filter(r=>r.status==='restored').map(r=>HOST[r.host]||'Codex'))].join(' e ao ')||'Codex';
 $('#flow-foot').textContent='O Jev escolhe o que guardar da conversa para '+agents(s)+' '+agentVerb(s,'continuar','continuarem')+' depois da compactação.';
 if(!s.restored){$('#flow').innerHTML='<p class="empty">Ainda sem compactação concluída.</p>';return}
 const read=s.completedCharsBefore,kept=s.completedCharsAfter,sent=s.injectedPayloadChars;
 const step=(label,n,hint)=>'<div class="flow-step"><span class="label">'+label+'</span><b class="num">'+f(n)+'</b><span class="hint">'+hint+'</span></div>';
 const arrow=(n,note)=>'<div class="flow-arrow"><span aria-hidden="true">→</span><span class="flow-note"><b class="num">−'+f(n)+'</b><br>'+note+'</span></div>';
 $('#flow').innerHTML='<div class="flow-steps'+(agent==='claude'?' two':'')+'">'
  +step('Texto da conversa analisado',read,'caracteres antes do corte')
  +arrow(Math.max(0,read-kept),'cortados pelo Jev')
  +step('Mantido pelo Jev',kept,'o que ainda é útil; o resto foi cortado')
  +(agent==='claude'?'':arrow(Math.max(0,kept-sent),'já no resumo ou acima do limite')
  +step('Enviado ao '+hosts,sent,'o que o resumo perdeu, dentro do limite'))+'</div>';
}
function renderRuns(runs){
 const shown=runs.filter(r=>r.status!=='ready'&&r.status!=='prepared').slice(0,10),max=Math.max(1,...shown.map(r=>r.charsBefore||0));
 $('#runs').innerHTML=shown.map(r=>{
  const failed=r.status==='failed'||r.status==='too_short'||!r.charsBefore,skipped=r.status==='skipped';
  const kept=skipped?'':'<i class="after" style="width:'+Math.max(0,Math.min(100,r.charsAfter/r.charsBefore*100))+'%"></i>';
  const bar='<div class="rb-bar">'+(failed?'':'<i class="before" style="width:'+(r.charsBefore/max*100)+'%">'+kept+'</i>')+'</div>';
  const after=failed?'—':skipped?'<span class="muted">sem corte</span>':f(r.charsAfter);
  const reduction=failed||skipped?'':'−'+Math.round(r.reductionRatio*100)+'%';
  return '<tr><td class="num">'+stamp(r.at)+'</td><td>'+statusPill(r)+'</td><td class="rb-grow">'+bar+'</td><td class="num right">'+(failed?'—':f(r.charsBefore))+'</td><td class="num right">'+after+'</td><td class="num rb-cut right">'+reduction+'</td></tr>';
 }).join('')||'<tr><td colspan="6" class="empty">Nenhuma compactação registrada ainda.</td></tr>';
}
let decisions=[],decisionFilter='all';
function riskCell(d){
 if(d.decision==='p')return '<span class="muted small">não avaliado</span>';
 const risk=Math.round(Math.max(0,Math.min(1,Number(d.dropLoss)||0))*100);
 return '<span class="risk"><span class="risk-bar"><i style="width:'+risk+'%"></i></span><span class="num">'+risk+'%</span></span>';
}
function renderDecisions(){
 $('#decisions').innerHTML=decisions.filter(d=>decisionFilter==='all'||d.decision===decisionFilter).slice(0,50).map(d=>
  '<tr><td class="num">'+shortStamp(d.at)+'</td><td><span class="cmd" title="'+esc(d.label)+'">'+esc(d.label)+'</span><span class="cmd-kind">'+esc(d.kind)+'</span></td><td>'+decisionPill(d.decision)+'</td><td>'+riskCell(d)+'</td><td class="num right">'+f(d.originalChars)+'</td><td class="num right">'+(d.removedChars?f(d.removedChars):'—')+'</td></tr>'
 ).join('')||'<tr><td colspan="6" class="empty">Nenhuma decisão registrada ainda.</td></tr>';
}
$('.filters').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;decisionFilter=b.dataset.filter;document.querySelectorAll('.filters button').forEach(o=>o.setAttribute('aria-pressed',String(o===b)));renderDecisions()});
function refresh(){
 return fetch('/api/stats'+(agent?'?agent='+agent:''),{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('HTTP '+r.status);return r.json()}).then(s=>{
  $('#error').innerHTML='';
  renderLastRun(s.lastCompaction);
  renderKpis(s);
  renderFlow(s);
  renderRuns(s.runs);
  decisions=s.recentDecisions;renderDecisions();
  $('#live').textContent='dados locais · atualizado '+new Date().toLocaleTimeString('pt-BR');
 });
}
function showError(error){$('#error').innerHTML='<div class="error">Erro ao ler dados: '+esc(String(error))+'</div>'}
let agent=null;
function remembered(){try{return localStorage.getItem('jevcomp-agent')}catch{return null}}
function pickAgent(id){
 agent=id;try{localStorage.setItem('jevcomp-agent',id)}catch{}
 document.querySelectorAll('#agent-switch button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.agent===id)));
 refresh().catch(showError);
 if(!$('#view-config').hidden)loadSettings();
}
$('#agent-switch').addEventListener('click',e=>{const b=e.target.closest('[data-agent]');if(b&&b.dataset.agent!==agent)pickAgent(b.dataset.agent)});
fetch('/api/settings',{cache:'no-store'}).then(r=>r.json()).then(s=>{
 const ids=installedAgents(s);
 $('#agent-switch').hidden=ids.length<2;
 const saved=new URLSearchParams(location.search).get('agent')||remembered();
 pickAgent(ids.includes(saved)?saved:ids.includes(s.lastAgent)?s.lastAgent:ids[0]||'codex');
}).catch(()=>refresh().catch(showError));
setInterval(()=>refresh().catch(showError),5000);

const SETTING_TEXT={
 'pin-recent-messages':{title:'Mensagens recentes que nunca são cortadas',help:'As mensagens mais novas ficam sempre inteiras. Mais alto é mais seguro; mais baixo deixa o jevcomp cortar mais.',label:v=>String(v),numbers:true},
 'loss-threshold':{title:'Quanto cortar',help:'O Jev estima o risco de cortar algo que AGENT ainda vai usar. Pouco: só corta o que tem risco baixo. Muito: corta mais.',label:v=>({0.3:'Pouco',0.5:'Normal',0.7:'Muito'})[Number(v)]||String(v)},
 'min-reduction-ratio':{title:'Só agir se cortar pelo menos',help:'Se o corte diminuir o texto menos que isso, o jevcomp não faz nada naquela compactação.',label:v=>Math.round(Number(v)*100)+'%',numbers:true}
};
const AGENT_NAME={codex:'o Codex',claude:'o Claude Code',agy:'o Antigravity'};
const installedAgents=s=>Object.keys(AGENT_NAME).filter(id=>id==='agy'?s.agents.agy?.installed:s.agents[id]);
const AGENT_TITLE={codex:'Codex',claude:'Claude Code',agy:'Antigravity'};
const PROVIDER_NAME={openrouter:'OpenRouter',typesafe:'TypeSafe'};
let settingsState=null,pendingProvider=null,changingKey=false;
const info=(label,value)=>'<div class="info"><span>'+label+'</span><b>'+value+'</b></div>';
const same=(a,b)=>String(a)===String(b)||(!Number.isNaN(Number(a))&&Number(a)===Number(b));
function ago(iso){if(!iso)return null;const m=Math.round((Date.now()-date(iso).getTime())/60000);if(m<1)return 'agora';if(m<60)return 'há '+m+' min';const h=Math.round(m/60);return h<24?'há '+h+' h':stamp(iso)}
function keyForm(name,withCancel){return '<form class="key-form" id="key-form"><label for="key-input" class="small muted">Chave '+name+'</label><input id="key-input" type="password" autocomplete="off" spellcheck="false"><div class="key-actions"><button class="btn primary" type="submit">Salvar chave</button>'+(withCancel?'<button class="btn" type="button" data-cancel>Cancelar</button>':'')+'</div></form>'}
function renderConnection(){
 const s=settingsState,shown=pendingProvider||s.provider,key=s.keys[shown],name=PROVIDER_NAME[shown],locked=!!s.providerLockedBy;
 const seg='<div class="seg" role="group" aria-label="Provedor"'+(locked?' aria-disabled="true"':'')+'>'+Object.keys(PROVIDER_NAME).map(id=>'<button type="button" data-pick="'+id+'" aria-pressed="'+(id===shown)+'"'+(locked?' disabled':'')+'>'+PROVIDER_NAME[id]+'</button>').join('')+'</div>';
 let body;
 if(key.source==='none')body=info('Chave','<span class="none">Sem chave</span>')+'<p class="conn-note warn">O jevcomp fica parado até você salvar a chave do '+name+'.</p>'+keyForm(name,false);
 else if(key.source==='environment')body=info('Chave','••••'+esc(key.ending||''))+'<p class="conn-note">Definida na variável '+esc(key.variable)+' '+SYSTEM+'. Para trocar, mude a variável e reinicie '+AGENT_NAME[agent]+'.</p>';
 else body=info('Chave','••••'+esc(key.ending||'')+' · salva neste computador')+(changingKey?keyForm(name,true):'<div class="key-actions"><button class="btn" type="button" data-change>Trocar chave</button></div>');
 const last=s.lastJev?(s.lastJev.ok?'Funcionou · ':'Falhou · ')+ago(s.lastJev.at):'Ainda nenhum';
 const lockNote=locked?'<p class="note" style="margin-top:10px">Definido pela variável '+esc(s.providerLockedBy)+' no seu sistema.</p>':'';
 $('#connection').innerHTML=seg+lockNote+'<div class="conn-body">'+body+(key.source==='none'||shown!==s.provider?'':info('Último uso do Jev',esc(last)))+'</div>';
}
function renderSettings(s){
 settingsState=s;
 renderConnection();
 const card=(title,sub,body)=>'<div class="card group"><div class="group-head"><h2>'+title+'</h2><span class="small muted">'+sub+'</span></div>'+body+'</div>';
 const version=' · '+esc(s.version),codex=agent==='codex'&&s.agents.codex,claude=agent==='claude'&&s.agents.claude;
 let cards='';
 if(codex){
  cards+=card('Codex','Como o jevcomp está ligado ao Codex',info('Instalação','Comando jevcomp'+version)
   +info('Uso','jevcomp codex')
   +info('Última compactação',codex.lastRun?esc(ago(codex.lastRun)):'Ainda nenhuma'));
 }
 if(claude)cards+=card('Claude Code','Como o jevcomp está ligado ao Claude Code',info('Instalação','Plugin do Claude Code'+version)
  +'<div class="info"><span>Compactação pelo jevcomp</span><span class="pill '+(claude.functionHooks?'ok':'fail')+'">'+(claude.functionHooks?'Ligada':'Desligada')+'</span></div>'
  +(claude.functionHooks?'':'<p class="conn-note warn">Abra uma sessão nova do Claude Code: o jevcomp liga a compactação sozinho e pede para reiniciar uma vez.</p>')
  +info('Última compactação',claude.lastRun?esc(ago(claude.lastRun)):'Ainda nenhuma'));
 const agy=agent==='agy'&&s.agents.agy?.installed;
 if(agy)cards+=card('Antigravity','Como o jevcomp está ligado ao Antigravity',info('Instalação','CA local instalada')+info('Uso','jevcomp agy'));
 if(!codex&&!claude&&!agy)cards+=card(AGENT_TITLE[agent],'Como o jevcomp está ligado ao '+AGENT_TITLE[agent],'<p class="conn-note warn">O jevcomp não está instalado no '+AGENT_TITLE[agent]+'.</p>');
 $('#agents-info').innerHTML=cards+card('Dashboard','Este painel','<div class="info"><span>Endereço</span><b class="num">'+esc(s.dashboardUrl)+'</b></div>');
 $('#behavior-sub').textContent=installedAgents(s).length>1?'Vale para '+installedAgents(s).map(id=>AGENT_TITLE[id]).join(' e ')+' · salvo na hora':'Cada mudança é salva na hora';
 $('#behavior').innerHTML=s.settings.filter(item=>agent==='codex'||!SETTING_TEXT[item.name].codexOnly).map(item=>{
  const text=SETTING_TEXT[item.name];
  const choices=item.choices.some(c=>same(c,item.value))?item.choices:item.choices.concat([item.value]);
  const locked=!!item.lockedBy;
  const buttons=choices.map(c=>'<button type="button" data-value="'+esc(c)+'" aria-pressed="'+same(c,item.value)+'"'+(locked?' disabled':'')+'>'+esc(text.label(c))+'</button>').join('');
  const note=(locked?'<span class="note">Definido pela variável '+esc(item.lockedBy)+' no seu sistema. Remova a variável para mudar aqui.</span>':'');
  return '<div class="setting"><h3>'+text.title+'</h3><p>'+text.help.replace('AGENT',AGENT_NAME[agent])+'</p><div class="control seg'+(text.numbers?' numbers':'')+'" role="group" aria-label="'+text.title+'" data-name="'+item.name+'"'+(locked?' aria-disabled="true"':'')+'>'+buttons+'</div>'+note+'</div>';
 }).join('');
}
function settingsUrl(){return '/api/settings?agent='+encodeURIComponent(agent||'codex')}
function loadSettings(){return fetch(settingsUrl(),{cache:'no-store'}).then(r=>r.json()).then(renderSettings).catch(e=>toast('Erro ao ler as configurações: '+e.message,true))}
function send(body,message){return fetch(settingsUrl(),{method:'POST',headers:{'content-type':'application/json','x-jevcomp-token':token},body:JSON.stringify(body)}).then(r=>r.json().then(j=>{if(!r.ok)throw Error(j.error||'HTTP '+r.status);return j})).then(s=>{renderSettings(s);toast(message||'Salvo');return true}).catch(e=>{toast('Não salvo: '+e.message,true);return false})}
$('#connection').addEventListener('click',e=>{
 if(!settingsState)return;
 if(e.target.closest('[data-change]')){changingKey=true;renderConnection();$('#key-input').focus();return}
 if(e.target.closest('[data-cancel]')){changingKey=false;renderConnection();return}
 const pick=e.target.closest('[data-pick]');
 if(!pick||pick.disabled)return;
 const id=pick.dataset.pick;
 if(id===(pendingProvider||settingsState.provider))return;
 changingKey=false;
 if(settingsState.keys[id].source==='none'){pendingProvider=id;renderConnection();$('#key-input').focus();return}
 pendingProvider=null;
 send({action:'provider',provider:id},'Agora usando '+PROVIDER_NAME[id]);
});
$('#connection').addEventListener('submit',e=>{
 e.preventDefault();
 const provider=pendingProvider||settingsState.provider,key=$('#key-input').value.trim();
 if(!key){toast('Cole a chave antes de salvar',true);return}
 const switching=provider!==settingsState.provider;
 pendingProvider=null;changingKey=false;
 send({action:'key',provider,key},switching?'Chave salva. Agora usando '+PROVIDER_NAME[provider]:'Chave salva');
});
$('#behavior').addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled)return;send({action:'setting',name:b.closest('.seg').dataset.name,value:b.dataset.value})});
function showReset(){
 const area=$('#reset-area .control');
 area.innerHTML='<button class="btn quiet" type="button" id="reset">Restaurar padrões</button>';
 $('#reset').addEventListener('click',()=>{
  area.innerHTML='<div class="confirm">Tem certeza? <button class="btn quiet" type="button" id="reset-yes">Restaurar</button><button class="btn" type="button" id="reset-no">Cancelar</button></div>';
  $('#reset-yes').addEventListener('click',()=>send({action:'reset'},'Padrões restaurados').then(showReset));
  $('#reset-no').addEventListener('click',showReset);
 });
}
showReset();
function showTab(name){document.querySelectorAll('.nav button').forEach(t=>{const on=t.id==='nav-'+name;t.setAttribute('aria-selected',String(on));document.getElementById(t.getAttribute('aria-controls')).hidden=!on});if(name==='config')loadSettings();history.replaceState(null,'',name==='config'?'#configuracoes':'#resumo')}
document.querySelectorAll('.nav button').forEach(t=>t.addEventListener('click',()=>showTab(t.id.slice(4))));
showTab(location.hash==='#configuracoes'?'config':'geral');
setInterval(()=>{if(!$('#view-config').hidden&&!$('#key-form'))loadSettings()},15000);
</script></body></html>`;
}

async function jsonBody(req: any): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 16_384) throw new Error('request too large');
  }
  const value = JSON.parse(text || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('request must be a JSON object');
  return value;
}

function json(res: any, value: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

export async function startDashboard(port = 43127, env = process.env): Promise<{ server: any; url: string }> {
  const host = '127.0.0.1';
  const cached = new Map<string, { identity: string; stats: Awaited<ReturnType<typeof stats>> }>();
  const currentStats = async (agent?: 'codex' | 'claude' | 'agy'): Promise<Awaited<ReturnType<typeof stats>>> => {
    const identityPart = async (path: string): Promise<string> => {
      try { const info = await stat(path); return `${info.size}:${info.mtimeMs}`; } catch { return 'missing'; }
    };
    // Dashboard content depends on both history and the persisted user-facing settings.
    const historyIdentity = await Promise.all(readableHistoryPaths(env).map(identityPart));
    const identity = `${historyIdentity.join('|')}|${await identityPart(settingsPath(env))}`;
    const hit = cached.get(agent ?? '');
    if (hit?.identity === identity) return hit.stats;
    const fresh = await stats(env, agent);
    cached.set(agent ?? '', { identity, stats: fresh });
    return fresh;
  };
  const token = randomUUID();
  // Checking Host blocks DNS-rebinding pages; the token and Origin stop other sites from changing settings.
  const trustedHost = (req: any): boolean => {
    const listening = server.address()?.port;
    return req.headers.host === `${host}:${listening}` || req.headers.host === `localhost:${listening}`;
  };
  const server = createServer(async (req: any, res: any) => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (!trustedHost(req)) return json(res, { error: 'forbidden' }, 403);
      if (url.pathname === '/api/settings' && req.method === 'POST') {
        const origin = req.headers.origin;
        if (req.headers['x-jevcomp-token'] !== token || (origin && origin !== `http://${req.headers.host}`)) return json(res, { error: 'forbidden' }, 403);
        const requestedAgent = url.searchParams.get('agent') ?? 'codex';
        if (requestedAgent !== 'codex' && requestedAgent !== 'claude' && requestedAgent !== 'agy') return json(res, { error: 'invalid agent' }, 400);
        try { await applySettingsChange(await jsonBody(req), env, requestedAgent); }
        catch (error) { return json(res, { error: error instanceof Error ? error.message : String(error) }, 400); }
        return json(res, await settingsSnapshot(env, requestedAgent));
      }
      if (url.pathname === '/api/settings') {
        const requestedAgent = url.searchParams.get('agent') ?? 'codex';
        if (requestedAgent !== 'codex' && requestedAgent !== 'claude' && requestedAgent !== 'agy') return json(res, { error: 'invalid agent' }, 400);
        return json(res, await settingsSnapshot(env, requestedAgent));
      }
      if (url.pathname === '/api/health') return json(res, {
        ok: true,
        service: 'jevcomp-dashboard',
        pid: process.pid,
        instanceId: env.JEVCOMP_DASHBOARD_INSTANCE_ID ?? null,
        entry: process.argv[1] ?? null,
        version: VERSION,
      });
      if (url.pathname === '/api/stats') {
        const agent = url.searchParams.get('agent');
        return json(res, await currentStats(agent === 'codex' || agent === 'claude' || agent === 'agy' ? agent : undefined));
      }
      if (url.pathname === '/api/history') return json(res, (await readHistory(env)).slice(-200).reverse());
      if (url.pathname !== '/') return json(res, { error: 'not found' }, 404);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page(token, process.platform));
    } catch (error) {
      json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('dashboard did not bind to a TCP port');
  return { server, url: `http://${host}:${address.port}/` };
}
