import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises';
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
