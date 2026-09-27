import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { dataDir } from './store.js';
export const defaultAuditConfig = () => ({ schema: 1, agents: {}, modes: {}, maxBytes: 500 * 1024 ** 2, retentionDays: 30, captureBytes: 8 * 1024 ** 2 });
export const auditRoot = (env) => join(dataDir(env), 'audit');
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const validId = (id) => /^[a-zA-Z0-9_-]{1,100}$/.test(id);
export const validHash = (id) => /^[a-f0-9]{64}$/.test(id);
export async function readJson(path) {
    return JSON.parse(await readFile(path, 'utf8'));
}
export async function auditConfig(env) {
    try {
        const stored = await readJson(join(auditRoot(env), 'config.json'));
        if (stored.schema !== 1 || !stored.agents || typeof stored.agents !== 'object')
            throw Error('invalid audit configuration');
        for (const section of [stored.agents, stored.modes ?? {}])
            for (const [agent, mode] of Object.entries(section)) {
                if ((agent !== 'codex' && agent !== 'claude') || (mode !== 'metadata' && mode !== 'evidence'))
                    throw Error('invalid audit agent or mode');
            }
        for (const key of ['maxBytes', 'retentionDays', 'captureBytes']) {
            if (!Number.isSafeInteger(stored[key]) || stored[key] <= 0)
                throw Error(`invalid audit ${key}`);
        }
        return stored;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return defaultAuditConfig();
        throw error;
    }
}
export async function atomicJson(path, value) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const staging = `${path}.${randomUUID()}.pending`;
    try {
        await writeFile(staging, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
        await rename(staging, path);
    }
    finally {
        await rm(staging, { force: true }).catch(() => { });
    }
}
export async function withAuditLock(env, action) {
    const root = auditRoot(env);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const lock = join(root, 'write.lock');
    let acquired = false;
    for (let attempt = 0; attempt < 20; attempt++) {
        try {
            await mkdir(lock);
            acquired = true;
            await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
            break;
        }
        catch (error) {
            if (acquired || error.code !== 'EEXIST')
                throw error;
            try {
                const owner = await readJson(join(lock, 'owner.json'));
                if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
                    try {
                        process.kill(owner.pid, 0);
                    }
                    catch (dead) {
                        if (dead.code === 'ESRCH')
                            await rm(lock, { recursive: true, force: true });
                    }
                }
            }
            catch { }
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }
    if (!acquired)
        throw Error('audit writer busy; capture not persisted');
    try {
        return await action();
    }
    finally {
        await rm(lock, { recursive: true, force: true });
    }
}
export async function directoryBytes(root) {
    let total = 0;
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        const path = join(root, entry.name);
        if (entry.isDirectory() && entry.name !== 'write.lock')
            total += await directoryBytes(path);
        else if (entry.isFile())
            total += (await stat(path)).size;
    }
    return total;
}
export async function reserveBytes(env, count, limit) {
    const root = auditRoot(env), ledgerPath = join(root, 'budget.json');
    let allocated;
    try {
        const ledger = await readJson(ledgerPath);
        if (!Number.isSafeInteger(ledger.reservedBytes) || ledger.reservedBytes < 0)
            throw Error('invalid audit budget');
        allocated = ledger.reservedBytes;
    }
    catch {
        allocated = await directoryBytes(root);
    }
    if (allocated + count > limit)
        throw Error('audit storage quota reached');
    await atomicJson(ledgerPath, { reservedBytes: allocated + count });
}
export class EvidenceGraph {
    limit;
    objects = new Map();
    bytes = 0;
    identities = new WeakMap();
    constructor(limit) {
        this.limit = limit;
    }
    pack(value, depth = 0) {
        if (depth > 100)
            throw Error('audit nesting limit reached');
        if (value && typeof value === 'object') {
            const existing = this.identities.get(value);
            if (existing)
                return existing;
        }
        const child = (item) => {
            if (item === null || item === undefined || typeof item === 'number' || typeof item === 'boolean' || (typeof item === 'string' && item.length <= 256))
                return { inline: item ?? null };
            return this.pack(item, depth + 1);
        };
        let packed;
        if (Array.isArray(value))
            packed = { array: value.map(child) };
        else if (value && typeof value === 'object') {
            packed = { object: Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, child(item)]) };
        }
        else
            packed = { scalar: value ?? null };
        const encoded = Buffer.from(JSON.stringify(packed));
        const hash = digest(encoded);
        if (!this.objects.has(hash)) {
            if (this.bytes + encoded.length > this.limit)
                throw Error('audit capture byte budget reached');
            this.bytes += encoded.length;
            this.objects.set(hash, gzipSync(encoded));
        }
        if (value && typeof value === 'object')
            this.identities.set(value, hash);
        return hash;
    }
}
export async function persistGraph(env, graph, limit) {
    const root = join(auditRoot(env), 'objects');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const missing = [];
    const entries = [...graph.objects];
    for (let start = 0; start < entries.length; start += 16) {
        const absent = await Promise.all(entries.slice(start, start + 16).map(async ([hash, bytes]) => {
            try {
                await stat(join(root, `${hash}.gz`));
                return undefined;
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
                return [hash, bytes];
            }
        }));
        for (const entry of absent)
            if (entry)
                missing.push(entry);
    }
    await reserveBytes(env, missing.reduce((sum, [, bytes]) => sum + bytes.length, 0), limit);
    for (let start = 0; start < missing.length; start += 8) {
        await Promise.all(missing.slice(start, start + 8).map(async ([hash, bytes]) => {
            const path = join(root, `${hash}.gz`);
            const staging = `${path}.${randomUUID()}.pending`;
            try {
                await writeFile(staging, bytes, { flag: 'wx', mode: 0o600 });
                await rename(staging, path);
            }
            finally {
                await rm(staging, { force: true }).catch(() => { });
            }
        }));
    }
}
export async function unpackEvidence(env, hash, maxBytes = 32 * 1024 ** 2) {
    let expanded = 0;
    async function unpack(key, depth) {
        if (!validHash(key) || depth > 100)
            throw Error('invalid audit object reference');
        const encoded = gunzipSync(await readFile(join(auditRoot(env), 'objects', `${key}.gz`)), { maxOutputLength: maxBytes });
        expanded += encoded.length;
        if (expanded > maxBytes || digest(encoded) !== key)
            throw Error('audit object integrity or expansion limit failure');
        const node = JSON.parse(encoded.toString('utf8'));
        if ('scalar' in node)
            return node.scalar;
        const valueOf = (child) => typeof child === 'string' ? unpack(child, depth + 1) : child.inline;
        if ('array' in node) {
            const result = [];
            for (const child of node.array)
                result.push(await valueOf(child));
            return result;
        }
        const result = Object.create(null);
        for (const [name, child] of node.object)
            result[name] = await valueOf(child);
        return result;
    }
    return unpack(hash, 0);
}
export async function configureAudit(env, agent, mode, enabled = mode !== undefined) {
    return withAuditLock(env, async () => {
        const config = await auditConfig(env);
        if (mode)
            (config.modes ??= {})[agent] = mode;
        else if (config.agents[agent])
            (config.modes ??= {})[agent] = config.agents[agent];
        const selectedMode = mode ?? config.modes?.[agent] ?? 'evidence';
        if (enabled)
            config.agents[agent] = selectedMode;
        else
            delete config.agents[agent];
        await atomicJson(join(auditRoot(env), 'config.json'), config);
        return config;
    });
}
