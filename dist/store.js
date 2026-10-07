import { appendFile, chmod, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { legacyHistoryPaths } from './legacy.js';
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
export function historyPath(env = process.env) { return join(dataDir(env), 'history.jsonl'); }
export function readableHistoryPaths(env = process.env) {
    const current = historyPath(env);
    if (env.JEVCOMP_DATA_DIR)
        return [current];
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
export async function appendHistory(row, env = process.env) {
    const path = historyPath(env);
    await ensurePrivateDir(dirname(path));
    await appendFile(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}
export async function tryAppendHistory(row, env = process.env) {
    try {
        await appendHistory(row, env);
        return true;
    }
    catch {
        return false;
    }
}
export function historyRetentionDays(env = process.env) {
    const value = Number(env.JEVCOMP_HISTORY_DAYS);
    return Number.isFinite(value) && value > 0 ? value : 7;
}
function parseRow(line) {
    let row;
    try {
        row = JSON.parse(line);
    }
    catch {
        return undefined;
    }
    if (!row || typeof row !== 'object' || typeof row.at !== 'string' || typeof row.sessionId !== 'string' || typeof row.status !== 'string')
        return undefined;
    return row;
}
const historyCache = new Map();
const READ_CHUNK = 16 * 1024 * 1024;
/**
 * Reads in chunks because a whole-file string breaks past ~512 MB, and keeps parsed rows so the dashboard only
 * parses what was appended since its last refresh. A partial last line waits for the next read.
 */
async function recentRows(path, cutoff) {
    let handle;
    try {
        handle = await open(path, 'r');
    }
    catch {
        return undefined;
    }
    try {
        const info = await handle.stat();
        const birth = Number(info.birthtimeMs);
        const cached = historyCache.get(path);
        const reuse = cached && cached.birth === birth && cached.size <= info.size;
        const rows = reuse ? cached.rows.filter((row) => row.at >= cutoff) : [];
        let stale = reuse ? cached.rows.length - rows.length : 0;
        let position = reuse ? cached.size : 0;
        let pending = Buffer.alloc(0);
        while (position + pending.length < info.size) {
            const chunk = Buffer.alloc(Math.min(READ_CHUNK, info.size - position - pending.length));
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, position + pending.length);
            if (!bytesRead)
                break;
            const data = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
            const end = data.lastIndexOf(10);
            if (end < 0) {
                pending = data;
                continue;
            }
            for (const raw of data.subarray(0, end).toString('utf8').split('\n')) {
                const line = raw.replace(/\r$/, '');
                const row = line ? parseRow(line) : undefined;
                if (!row)
                    continue;
                if (row.at < cutoff)
                    stale++;
                else
                    rows.push(row);
            }
            position += end + 1;
            pending = data.subarray(end + 1);
        }
        historyCache.set(path, { size: position, birth, rows });
        return { rows, stale, size: position };
    }
    finally {
        await handle.close().catch(() => { });
    }
}
/** Rows appended by other agents while we rewrote are copied over before the swap so none are lost. */
async function rewriteHistory(path, kept, readSize) {
    const temporary = `${path}.${process.pid}.tmp`;
    historyCache.delete(path);
    try {
        await writeFile(temporary, kept.map((row) => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 });
        const handle = await open(path, 'r');
        try {
            const { size } = await handle.stat();
            if (size > readSize) {
                const tail = Buffer.alloc(size - readSize);
                await handle.read(tail, 0, tail.length, readSize);
                await appendFile(temporary, tail);
            }
        }
        finally {
            await handle.close().catch(() => { });
        }
        await rename(temporary, path);
    }
    catch {
        await rm(temporary, { force: true }).catch(() => { });
    }
}
export async function readHistory(env = process.env) {
    const rows = new Map();
    const cutoff = new Date(Date.now() - historyRetentionDays(env) * 86_400_000).toISOString();
    const current = historyPath(env);
    for (const path of readableHistoryPaths(env)) {
        const result = await recentRows(path, cutoff);
        if (!result)
            continue;
        for (const row of result.rows) {
            const key = row.runId ? `${row.sessionId}\u0000${row.runId}\u0000${row.phase ?? ''}\u0000${row.status}` : JSON.stringify(row);
            rows.set(key, row);
        }
        if (path === current && result.stale)
            await rewriteHistory(path, result.rows, result.size);
    }
    return [...rows.values()].sort((left, right) => left.at.localeCompare(right.at));
}
