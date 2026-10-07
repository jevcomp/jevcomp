import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { configureAudit } from './audit-store.js';
import { dataDir } from './store.js';
/** Relative prices per token, normalized to uncached input; typical of current Anthropic, OpenAI and Gemini tariffs. */
export const COST_WEIGHTS = { input: 1, cached: 0.1, cacheWrite: 1.25, output: 5 };
const MIN_SAMPLES = 15;
const MAX_SAMPLES = 60;
const TARGET_HALF_WIDTH = 0.05;
const IDLE_MS = 6 * 3_600_000;
const WINDOW = { codex: { size: 10, minimum: 3 }, claude: { size: 10, minimum: 3 }, agy: { size: 40, minimum: 10 } };
const statePath = (env) => join(dataDir(env), 'experiment.json');
const rowsPath = (env) => join(dataDir(env), 'experiment.jsonl');
async function readState(env) {
    try {
        const value = JSON.parse(await readFile(statePath(env), 'utf8'));
        if (value?.schema === 1 && value.active && value.results)
            return value;
    }
    catch { }
    return { schema: 1, active: {}, results: {} };
}
async function writeState(env, state) {
    await mkdir(dataDir(env), { recursive: true, mode: 0o700 });
    const staging = `${statePath(env)}.${randomUUID()}.tmp`;
    await writeFile(staging, JSON.stringify(state), { mode: 0o600 });
    await rename(staging, statePath(env));
}
async function append(env, row) {
    await mkdir(dataDir(env), { recursive: true, mode: 0o700 });
    await appendFile(rowsPath(env), `${JSON.stringify(row)}\n`, { mode: 0o600 });
}
async function readRows(env, runId) {
    let text;
    try {
        text = await readFile(rowsPath(env), 'utf8');
    }
    catch {
        return [];
    }
    const rows = [];
    for (const line of text.split('\n')) {
        if (!line.includes(runId))
            continue;
        try {
            const row = JSON.parse(line);
            if (row.runId === runId)
                rows.push(row);
        }
        catch { }
    }
    return rows;
}
export async function activeRun(env, agent) {
    return (await readState(env)).active[agent]?.runId;
}
export async function startExperiment(env, agent) {
    const state = await readState(env);
    if (state.active[agent])
        return;
    state.active[agent] = { runId: randomUUID(), startedAt: new Date().toISOString() };
    await writeState(env, state);
    if (!Object.keys(state.active).some((other) => other !== agent))
        await writeFile(rowsPath(env), '', { mode: 0o600 });
    try {
        await configureAudit(env, agent, 'evidence');
    }
    catch { }
}
export async function stopExperiment(env, agent, result) {
    const state = await readState(env);
    delete state.active[agent];
    if (result)
        state.results[agent] = result;
    await writeState(env, state);
    try {
        await configureAudit(env, agent);
    }
    catch { }
}
function units(usage) {
    return usage.input * COST_WEIGHTS.input + usage.cached * COST_WEIGHTS.cached
        + usage.cacheWrite * COST_WEIGHTS.cacheWrite + usage.output * COST_WEIGHTS.output;
}
function samples(agent, rows, now) {
    const arms = rows.filter((row) => row.type === 'arm');
    const fellBack = new Set(rows.flatMap((row) => row.type === 'fallback' ? [row.unitId] : []));
    const usage = rows.filter((row) => row.type === 'usage').sort((a, b) => a.at.localeCompare(b.at));
    const { size, minimum } = WINDOW[agent];
    const ready = [];
    let pending = 0;
    for (const unit of arms) {
        const nextUnit = arms.find((other) => other.sessionId === unit.sessionId && other.at > unit.at);
        let window = usage.filter((row) => row.sessionId === unit.sessionId && row.at > unit.at && (!nextUnit || row.at < nextUnit.at));
        let compactionCost = 0;
        if (agent !== 'agy') {
            // Side requests (titles, quick checks) run on a different model and would dilute the window.
            const main = window.reduce((best, row) => !best || units(row.usage) > units(best.usage) ? row : best, undefined)?.model;
            window = window.filter((row) => row.model === main);
            const compaction = agent === 'codex'
                ? window.filter((row) => row.compaction)
                : unit.arm === 'native' || fellBack.has(unit.unitId) ? window.slice(0, 1) : [];
            compactionCost = compaction.reduce((sum, row) => sum + units(row.usage), 0);
            window = window.filter((row) => !compaction.includes(row));
        }
        const turns = window.slice(0, size);
        const last = turns.length ? Date.parse(turns[turns.length - 1].at) : Date.parse(unit.at);
        if (turns.length < size && (turns.length < minimum || now - last < IDLE_MS)) {
            pending++;
            continue;
        }
        const mean = turns.reduce((sum, row) => sum + units(row.usage), 0) / turns.length;
        ready.push({ arm: unit.arm, cost: compactionCost + mean * size, unitId: unit.unitId });
    }
    return { ready, pending };
}
function random(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
}
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
function estimate(ready, rows) {
    const jev = ready.filter((item) => item.arm === 'jev').map((item) => item.cost);
    const native = ready.filter((item) => item.arm === 'native').map((item) => item.cost);
    if (!jev.length || !native.length)
        return undefined;
    const saving = (a, b) => 1 - mean(a) / mean(b);
    const next = random(jev.length * 7919 + native.length);
    const draws = [];
    for (let i = 0; i < 2000; i++) {
        const pick = (values) => values.map(() => values[Math.floor(next() * values.length)]);
        draws.push(saving(pick(jev), pick(native)));
    }
    draws.sort((a, b) => a - b);
    const interval = [draws[49], draws[1949]];
    const used = new Set(ready.map((item) => item.unitId));
    const jevRows = rows.filter((row) => row.type === 'jev' && used.has(row.unitId));
    return {
        samples: { jev: jev.length, native: native.length },
        meanCost: { jev: mean(jev), native: mean(native) },
        savingRatio: saving(jev, native),
        interval,
        verdict: interval[0] > 0 ? 'gain' : interval[1] < 0 ? 'loss' : 'no_difference',
        jevTokens: { input: jevRows.reduce((sum, row) => sum + row.input, 0), output: jevRows.reduce((sum, row) => sum + row.output, 0) },
    };
}
/** Evaluates the running measurement; once the verdict is settled it is saved and the measurement switches itself off. */
export async function experimentProgress(env, agent) {
    const state = await readState(env);
    const run = state.active[agent];
    const lastResult = state.results[agent];
    if (!run)
        return { active: false, samples: { jev: 0, native: 0 }, pending: 0, needed: MIN_SAMPLES, progress: 0, done: false, ...(lastResult ? { lastResult } : {}) };
    const rows = await readRows(env, run.runId);
    const { ready, pending } = samples(agent, rows, Date.now());
    const result = estimate(ready, rows);
    const count = { jev: ready.filter((item) => item.arm === 'jev').length, native: ready.filter((item) => item.arm === 'native').length };
    const smaller = Math.min(count.jev, count.native);
    const decisive = !!result && (result.interval[0] > 0 || result.interval[1] < 0 || (result.interval[1] - result.interval[0]) / 2 <= TARGET_HALF_WIDTH);
    const done = !!result && ((smaller >= MIN_SAMPLES && decisive) || smaller >= MAX_SAMPLES);
    const needed = smaller < MIN_SAMPLES || decisive ? MIN_SAMPLES : MAX_SAMPLES;
    const progress = done ? 1 : smaller < MIN_SAMPLES ? 0.8 * smaller / MIN_SAMPLES : 0.8 + 0.15 * (smaller - MIN_SAMPLES) / (MAX_SAMPLES - MIN_SAMPLES);
    if (done && result) {
        const finished = { startedAt: run.startedAt, finishedAt: new Date().toISOString(), ...result };
        await stopExperiment(env, agent, finished);
        return { active: false, samples: count, pending, needed, progress: 1, done: true, lastResult: finished };
    }
    return { active: true, startedAt: run.startedAt, samples: count, pending, needed, progress, done: false, ...(result ? { estimate: result } : {}), ...(lastResult ? { lastResult } : {}) };
}
/**
 * Codex and Claude draw one arm per compaction; Antigravity has no compaction moment, so the whole session shares one.
 * Undefined means no measurement is running and Jev acts as usual.
 */
export async function assignArm(env, agent, sessionId) {
    try {
        if (!await activeRun(env, agent))
            return undefined;
        const progress = await experimentProgress(env, agent);
        const runId = await activeRun(env, agent);
        if (!progress.active || !runId)
            return undefined;
        const arms = (await readRows(env, runId)).filter((row) => row.type === 'arm');
        if (agent === 'agy') {
            const existing = arms.find((row) => row.sessionId === sessionId);
            if (existing)
                return { arm: existing.arm, unitId: existing.unitId };
        }
        const jev = arms.filter((row) => row.arm === 'jev').length, native = arms.length - jev;
        const arm = jev === native ? (Math.random() < 0.5 ? 'jev' : 'native') : jev < native ? 'jev' : 'native';
        const unitId = randomUUID();
        await append(env, { type: 'arm', runId, agent, unitId, sessionId, arm, at: new Date().toISOString() });
        return { arm, unitId };
    }
    catch {
        return undefined;
    }
}
/** Feeds every JSON `data:` payload of a server-sent event stream to `onData`, tolerating chunk boundaries anywhere. */
export function sseTap(onData) {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    const drain = (final) => {
        const lines = buffer.split('\n');
        buffer = final ? '' : lines.pop() ?? '';
        for (const line of lines) {
            if (!line.startsWith('data:'))
                continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]')
                continue;
            try {
                onData(JSON.parse(data));
            }
            catch { }
        }
        if (buffer.length > 4 * 1024 * 1024)
            buffer = '';
    };
    return {
        push(chunk) { buffer += decoder.write(chunk); drain(false); },
        end() { buffer += decoder.end(); drain(true); },
    };
}
export async function recordUsage(env, agent, sessionId, usage, model, compaction = false) {
    if (!sessionId || !usage)
        return;
    try {
        const runId = await activeRun(env, agent);
        if (!runId)
            return;
        await append(env, { type: 'usage', runId, agent, sessionId, at: new Date().toISOString(), ...(model ? { model } : {}), usage, ...(compaction ? { compaction } : {}) });
    }
    catch { }
}
/** Claude Code summarizes by itself whenever Jev's cut is not applied; that summary is then the compaction cost. */
export async function recordFallback(env, agent, unitId) {
    if (!unitId)
        return;
    try {
        const runId = await activeRun(env, agent);
        if (runId)
            await append(env, { type: 'fallback', runId, agent, unitId });
    }
    catch { }
}
export async function recordJevTokens(env, agent, unitId, input, output) {
    if (!unitId)
        return;
    try {
        const runId = await activeRun(env, agent);
        if (!runId)
            return;
        await append(env, { type: 'jev', runId, agent, unitId, input: input ?? 0, output: output ?? 0 });
    }
    catch { }
}
