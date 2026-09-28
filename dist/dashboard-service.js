import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_DASHBOARD_SERVICE } from './legacy.js';
import { dataDir } from './store.js';
import { VERSION } from './version.js';
export const DEFAULT_DASHBOARD_PORT = 43127;
const DASHBOARD_SERVICES = ['jevcomp-dashboard', LEGACY_DASHBOARD_SERVICE];
const defaultCliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
export function dashboardPort(env = process.env) {
    const port = Number(env.JEVCOMP_DASHBOARD_PORT);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_DASHBOARD_PORT;
}
export function dashboardInstancePath(port, env = process.env) {
    return join(dataDir(env), `dashboard-${port}.json`);
}
function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return !!error && typeof error === 'object' && 'code' in error && error.code === 'EPERM';
    }
}
export async function runningDashboard(port, env = process.env) {
    if (port === 0)
        return undefined;
    let instance;
    try {
        instance = JSON.parse(await readFile(dashboardInstancePath(port, env), 'utf8'));
    }
    catch {
        return undefined;
    }
    if (!Number.isSafeInteger(instance?.pid) || instance.pid <= 0 ||
        typeof instance.instanceId !== 'string' || !instance.instanceId ||
        typeof instance.url !== 'string')
        return undefined;
    // Windows retries refused loopback connections for about a second, so skip the request when the process is gone.
    if (!processAlive(instance.pid))
        return undefined;
    try {
        const url = new URL(instance.url);
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port || url.pathname !== '/')
            return undefined;
        const response = await fetch(new URL('/api/health', url), { signal: AbortSignal.timeout(1000) });
        if (!response.ok)
            return undefined;
        const health = await response.json();
        return DASHBOARD_SERVICES.includes(health.service) && health.pid === instance.pid && health.instanceId === instance.instanceId
            ? { ...instance, entry: typeof health.entry === 'string' ? health.entry : undefined, version: typeof health.version === 'string' ? health.version : undefined } : undefined;
    }
    catch {
        return undefined;
    }
}
/** Finds a dashboard of ours whose instance file lives elsewhere, such as one started under the old name. */
async function untrackedDashboard(port) {
    const url = `http://127.0.0.1:${port}/`;
    try {
        const health = await (await fetch(new URL('/api/health', url), { signal: AbortSignal.timeout(1000) })).json();
        return DASHBOARD_SERVICES.includes(health.service) && Number.isSafeInteger(health.pid)
            ? { pid: health.pid, url, entry: typeof health.entry === 'string' ? health.entry : undefined, version: typeof health.version === 'string' ? health.version : undefined }
            : undefined;
    }
    catch {
        return undefined;
    }
}
export async function stopDashboard(port, env) {
    const previous = await runningDashboard(port, env);
    if (previous)
        await stopProcess(previous, port);
}
async function stopProcess(previous, port) {
    try {
        process.kill(previous.pid);
    }
    catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH'))
            throw error;
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        try {
            await fetch(new URL('/api/health', previous.url), { signal: AbortSignal.timeout(500) });
        }
        catch {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`previous Jev dashboard did not stop on port ${port}`);
}
async function spawnDashboard(port, env, cliPath) {
    try {
        return await spawnOnFreePort(port, env, cliPath);
    }
    catch (error) {
        const orphan = error instanceof Error && error.message.includes('EADDRINUSE') ? await untrackedDashboard(port) : undefined;
        if (!orphan)
            throw error;
        await stopProcess(orphan, port);
        return spawnOnFreePort(port, env, cliPath);
    }
}
async function spawnOnFreePort(port, env, cliPath) {
    const instanceId = randomUUID();
    const child = spawn(process.execPath, [cliPath, 'dashboard', '--port', String(port), '--background'], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...env, JEVCOMP_DASHBOARD_INSTANCE_ID: instanceId },
    });
    child.unref();
    return new Promise((resolve, reject) => {
        let output = '';
        let errorOutput = '';
        let settled = false;
        const timeout = setTimeout(() => finish(new Error('dashboard did not start within 15 seconds')), 15000);
        const finish = (error, url) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            child.stdout?.destroy();
            child.stderr?.destroy();
            if (error)
                reject(error);
            else
                resolve(url ?? '');
        };
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => {
            output += chunk;
            const line = output.split(/\r?\n/, 1)[0];
            if (line)
                finish(undefined, line);
        });
        child.stderr?.on('data', (chunk) => { errorOutput += chunk; });
        child.once('error', (error) => finish(error));
        child.once('exit', (code) => finish(new Error(errorOutput.trim() || `dashboard process exited (${code})`)));
    });
}
/** Replaces any dashboard already on the port, so an explicit launch always serves the current code. */
export async function restartDashboard(port, env = process.env, cliPath = defaultCliPath) {
    await stopDashboard(port, env);
    return spawnDashboard(port, env, cliPath);
}
function olderThanOurs(version) {
    const parts = (value) => {
        if (!value)
            return undefined;
        const parsed = value.split('.').map(Number);
        return parsed.length > 0 && parsed.every((part) => Number.isInteger(part) && part >= 0) ? parsed : undefined;
    };
    const theirs = parts(version), ours = parts(VERSION);
    if (!theirs || !ours)
        return true;
    for (let i = 0; i < Math.max(theirs.length, ours.length); i++) {
        const difference = (theirs[i] ?? 0) - (ours[i] ?? 0);
        if (difference)
            return difference < 0;
    }
    return false;
}
/** Reuses a healthy dashboard, replacing one left running by an older installed version. */
export async function ensureDashboard(port, env = process.env, cliPath = defaultCliPath) {
    // The Codex and Claude Code plugins each start their own copy, so any of ours at least this new serves both.
    const running = await runningDashboard(port, env) ?? await untrackedDashboard(port);
    if (running && !olderThanOurs(running.version))
        return running.url;
    if (running)
        await stopProcess(running, port);
    return spawnDashboard(port, env, cliPath);
}
