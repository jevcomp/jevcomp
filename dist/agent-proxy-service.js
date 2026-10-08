import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const SPECS = {
    codex: { command: 'codex-proxy', service: 'jevcomp-codex-proxy', port: 16_393, portEnv: 'JEVCOMP_CODEX_PROXY_PORT' },
    agy: { command: 'agy-proxy', service: 'jevcomp-agy-proxy', port: 16_394, portEnv: 'JEVCOMP_AGY_PROXY_PORT' },
};
const defaultCliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
export function agentProxyPort(kind, env = process.env) {
    const spec = SPECS[kind];
    const value = Number(env[spec.portEnv]);
    return Number.isInteger(value) && value > 0 && value < 65_536 ? value : spec.port;
}
export function agentProxyUrl(kind, env = process.env) {
    return `http://127.0.0.1:${agentProxyPort(kind, env)}`;
}
async function buildIdentity() {
    const directory = fileURLToPath(new URL('.', import.meta.url));
    const names = (await readdir(directory)).filter((name) => name.endsWith('.js')).sort();
    const hash = createHash('sha256');
    for (const name of names) {
        hash.update(name);
        try {
            hash.update(await readFile(new URL(name, import.meta.url)));
        }
        catch {
            hash.update(':unavailable');
        }
    }
    return hash.digest('hex');
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
export async function runningAgentProxy(kind, env = process.env) {
    const spec = SPECS[kind];
    const url = agentProxyUrl(kind, env);
    try {
        const response = await fetch(`${url}/__jevcomp/health`, { signal: AbortSignal.timeout(1000) });
        if (!response.ok)
            return undefined;
        const health = await response.json();
        if (health.service !== spec.service || !Number.isSafeInteger(health.pid) || Number(health.pid) <= 0 ||
            typeof health.instanceId !== 'string' || typeof health.build !== 'string' || typeof health.config !== 'string')
            return undefined;
        const pid = Number(health.pid);
        if (!processAlive(pid))
            return undefined;
        return {
            pid,
            instanceId: health.instanceId,
            url,
            build: health.build,
            config: health.config,
            ...(typeof health.version === 'string' ? { version: health.version } : {}),
        };
    }
    catch {
        return undefined;
    }
}
async function stopOwnedInstance(kind, instance, env) {
    try {
        process.kill(instance.pid);
    }
    catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH'))
            throw error;
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        if (!await runningAgentProxy(kind, env))
            return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (await runningAgentProxy(kind, env))
        throw new Error(`${kind} proxy did not stop`);
}
export async function stopAgentProxy(kind, env = process.env) {
    const running = await runningAgentProxy(kind, env);
    if (running)
        await stopOwnedInstance(kind, running, env);
}
async function spawnProxy(kind, config, build, env, cliPath) {
    const spec = SPECS[kind];
    const port = agentProxyPort(kind, env);
    const instanceId = randomUUID();
    const child = spawn(process.execPath, [cliPath, spec.command, '--port', String(port), '--background'], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
            ...env,
            JEVCOMP_AGENT_PROXY_INSTANCE_ID: instanceId,
            JEVCOMP_AGENT_PROXY_BUILD: build,
            JEVCOMP_AGENT_PROXY_CONFIG: config,
        },
    });
    child.unref();
    return new Promise((resolve, reject) => {
        let stdout = '', stderr = '', settled = false;
        const timeout = setTimeout(() => finish(new Error(`${kind} proxy did not start within 15 seconds`)), 15_000);
        const finish = (error, instance) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            child.stdout?.destroy();
            child.stderr?.destroy();
            if (error)
                reject(error);
            else
                resolve(instance);
        };
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => {
            stdout += chunk;
            if (!stdout.includes('\n'))
                return;
            void runningAgentProxy(kind, env).then((instance) => {
                if (instance?.instanceId === instanceId)
                    finish(undefined, instance);
            });
        });
        child.stderr?.on('data', (chunk) => { stderr += chunk; });
        child.once('error', (error) => finish(error));
        child.once('exit', (code) => finish(new Error(stderr.trim() || `${kind} proxy process exited (${code})`)));
    });
}
export async function ensureAgentProxy(kind, config, env = process.env, cliPath = defaultCliPath) {
    const build = await buildIdentity();
    const running = await runningAgentProxy(kind, env);
    if (running && running.build === build && running.config === config)
        return running;
    if (running)
        await stopOwnedInstance(kind, running, env);
    return spawnProxy(kind, config, build, env, cliPath);
}
