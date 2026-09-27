import { appendFile, chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { legacyHistoryPaths } from './legacy.js';
function safe(value) { return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 180); }
/** One folder for every agent, so the Codex and Claude Code plugins share history and the dashboard. */
export function dataDir(env = process.env) {
    return env.JEVCOMP_DATA_DIR ?? join(homedir(), '.jevcomp');
}
/** JEVCOMP_CAPTURE=1 saves under ~/.jevcomp; any other value is taken as the folder itself. */
export function captureDirectory(env, folder) {
    const value = env.JEVCOMP_CAPTURE?.trim();
    if (!value || value === '0')
        return undefined;
    return value === '1' ? join(dataDir(env), folder) : value;
}
export function statePath(sessionId, env = process.env) { return join(dataDir(env), 'sessions', `${safe(sessionId)}.json`); }
export function contextPath(sessionId, env = process.env) { return join(dataDir(env), 'sessions', `${safe(sessionId)}.context.txt`); }
export function messagesPath(sessionId, env = process.env) { return join(dataDir(env), 'sessions', `${safe(sessionId)}.messages.json`); }
export function historyPath(env = process.env) { return join(dataDir(env), 'history.jsonl'); }
export function readableHistoryPaths(env = process.env) {
    const current = historyPath(env);
    if (env.JEVCOMP_DATA_DIR)
        return [current];
    // Versions before 0.7.0 kept data in the Codex folders.
    const standalone = join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'jevcomp', 'history.jsonl');
    const pluginData = [env.PLUGIN_DATA].filter((dir) => !!dir).map((dir) => join(dir, 'history.jsonl'));
    return [...new Set([...legacyHistoryPaths(env), standalone, ...pluginData, current])];
}
async function ensurePrivateDir(path) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    try {
        await chmod(path, 0o700);
    }
    catch { }
}
async function atomicWrite(path, text) {
    await ensurePrivateDir(dirname(path));
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
        await writeFile(tmp, text, { mode: 0o600 });
        await rename(tmp, path);
    }
    finally {
        try {
            await rm(tmp, { force: true });
        }
        catch { }
    }
}
export async function prepareState(state, context, env = process.env, messages) {
    const cp = contextPath(state.sessionId, env);
    const mp = messages?.length ? messagesPath(state.sessionId, env) : undefined;
    const full = {
        version: 1,
        ...state,
        ready: false,
        consumed: false,
        contextFile: cp,
        ...(mp ? { messagesFile: mp } : {}),
        contextChars: context.length,
    };
    const archiveWrites = [atomicWrite(cp, context)];
    if (mp)
        archiveWrites.push(atomicWrite(mp, `${JSON.stringify(messages)}\n`));
    // Publish the state only after both archives are durable; archive writes are independent.
    await Promise.all(archiveWrites);
    await atomicWrite(statePath(state.sessionId, env), JSON.stringify(full));
    return full;
}
export async function discardPendingState(sessionId, env = process.env) {
    try {
        await rm(statePath(sessionId, env), { force: true });
    }
    catch { }
}
function processAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code ?? '') : '';
        return code === 'EPERM';
    }
}
async function recoverOrphanClaim(path) {
    let names;
    try {
        names = await readdir(dirname(path));
    }
    catch {
        return;
    }
    const base = path.slice(dirname(path).length + 1);
    const prefix = `${base}.`;
    for (const name of names) {
        if (!name.startsWith(prefix) || !name.endsWith('.claim'))
            continue;
        const rawPid = name.slice(prefix.length, -'.claim'.length);
        const pid = Number(rawPid);
        if (processAlive(pid))
            continue;
        try {
            await rename(join(dirname(path), name), path);
            return;
        }
        catch { }
    }
}
export async function readState(sessionId, env = process.env) {
    const path = statePath(sessionId, env);
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const parsed = JSON.parse(await readFile(path, 'utf8'));
            return parsed?.version === 1 ? parsed : undefined;
        }
        catch (error) {
            if (attempt === 0 && error && typeof error === 'object' && 'code' in error && String(error.code) === 'ENOENT') {
                await recoverOrphanClaim(path);
                continue;
            }
            return undefined;
        }
    }
    return undefined;
}
function validReadyState(parsed, ttlMs) {
    const age = Date.now() - Date.parse(parsed.createdAt);
    return parsed.version === 1 && parsed.ready && !parsed.consumed && Number.isFinite(age) && age >= 0 && age <= ttlMs;
}
export async function peekReady(sessionId, ttlMs, env = process.env) {
    const state = await readState(sessionId, env);
    return state && validReadyState(state, ttlMs) ? state : undefined;
}
export async function markReady(sessionId, turnId, env = process.env) {
    const state = await readState(sessionId, env);
    if (!state || (state.turnId && turnId && state.turnId !== turnId))
        return undefined;
    const next = { ...state, ready: true };
    await atomicWrite(statePath(sessionId, env), JSON.stringify(next));
    return next;
}
export async function claimReady(sessionId, ttlMs, env = process.env, expectedCreatedAt) {
    const path = statePath(sessionId, env);
    const claim = `${path}.${process.pid}.claim`;
    try {
        await rename(path, claim);
    }
    catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || String(error.code) !== 'ENOENT')
            return undefined;
        await recoverOrphanClaim(path);
        try {
            await rename(path, claim);
        }
        catch {
            return undefined;
        }
    }
    let state;
    try {
        const parsed = JSON.parse(await readFile(claim, 'utf8'));
        if (validReadyState(parsed, ttlMs) && (!expectedCreatedAt || parsed.createdAt === expectedCreatedAt))
            state = parsed;
        const next = { ...parsed, consumed: !!state || parsed.consumed };
        await atomicWrite(path, JSON.stringify(next));
    }
    catch {
        try {
            await rename(claim, path);
        }
        catch { }
        return undefined;
    }
    try {
        await rm(claim, { force: true });
    }
    catch { }
    return state;
}
/** Best-effort cleanup of stale per-session sidecars. History is intentionally retained. */
export async function sweep(env = process.env, maxAgeMs = 48 * 60 * 60 * 1000) {
    const dir = join(dataDir(env), 'sessions');
    const cutoff = Date.now() - Math.max(0, maxAgeMs);
    let removed = 0;
    let names;
    try {
        names = await readdir(dir);
    }
    catch {
        return 0;
    }
    for (const name of names) {
        if (!/\.(?:json|txt|claim)$/.test(name))
            continue;
        const path = join(dir, name);
        try {
            const info = await stat(path);
            if (info.mtimeMs < cutoff) {
                await rm(path, { force: true });
                removed++;
            }
        }
        catch { }
    }
    return removed;
}
export async function appendHistory(row, env = process.env) {
    const path = historyPath(env);
    await ensurePrivateDir(dirname(path));
    await appendFile(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}
/** History is observability only; hook correctness must never depend on this write succeeding. */
export async function tryAppendHistory(row, env = process.env) {
    try {
        await appendHistory(row, env);
        return true;
    }
    catch {
        return false;
    }
}
export async function readHistory(env = process.env) {
    const rows = new Map();
    for (const path of readableHistoryPaths(env)) {
        let lines;
        try {
            lines = (await readFile(path, 'utf8')).split(/\r?\n/);
        }
        catch {
            continue;
        }
        for (const line of lines) {
            if (!line)
                continue;
            let row;
            try {
                row = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (!row || typeof row !== 'object' || typeof row.at !== 'string' || typeof row.sessionId !== 'string' || typeof row.status !== 'string')
                continue;
            const key = row.runId ? `${row.sessionId}\u0000${row.runId}\u0000${row.phase ?? ''}\u0000${row.status}` : line;
            rows.set(key, row);
        }
    }
    return [...rows.values()].sort((left, right) => left.at.localeCompare(right.at));
}
export function hookActivityPath(env = process.env) { return join(dataDir(env), 'hook-activity.json'); }
export async function readHookActivity(env = process.env) {
    try {
        const value = JSON.parse(await readFile(hookActivityPath(env), 'utf8'));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }
    catch {
        return {};
    }
}
/** Remembers when Codex last ran each hook, as proof the hooks are active. */
export async function recordHookActivity(event, env = process.env) {
    if (!['SessionStart', 'UserPromptSubmit', 'PreCompact', 'PostCompact'].includes(event))
        return;
    const activity = { ...await readHookActivity(env), [event]: new Date().toISOString() };
    await ensurePrivateDir(dataDir(env));
    await writeFile(hookActivityPath(env), JSON.stringify(activity), { mode: 0o600 });
}
