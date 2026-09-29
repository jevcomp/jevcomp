import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from './version.js';
import { auditConfig, auditRoot, atomicJson, digest, EvidenceGraph, persistGraph, readJson, reserveBytes, validId, withAuditLock } from './audit-store.js';
let buildIdentity;
function buildHash() {
    return buildIdentity ??= Promise.all(['compact.js', 'provider.js', 'claude.js', 'claude-compact.js', 'codex-proxy.js', 'codex-compaction.js', 'agy-compact.js', 'agy-proxy.js', 'agy-audit.js', 'render.js', 'audit.js'].map(async (name) => {
        try {
            return await readFile(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
        }
        catch {
            return `${name}:unavailable`;
        }
    })).then(parts => digest(parts.join('\n')));
}
export function observeAudit(observer, event, value) {
    try {
        observer?.(event, value);
    }
    catch { }
}
function inputText(value) { return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value); }
export function messageHash(messages) { return digest(JSON.stringify(messages)); }
export class AuditCapture {
    env;
    quota;
    graph;
    captureTime = 0;
    closed = false;
    manifest;
    constructor(env, quota, limit, manifest) {
        this.env = env;
        this.quota = quota;
        this.graph = new EvidenceGraph(limit);
        this.manifest = manifest;
    }
    observe = (event, value) => {
        if (this.closed)
            return;
        const start = performance.now();
        try {
            const encoded = JSON.stringify(value);
            const hash = digest(encoded);
            this.manifest.hashes[event] = hash;
            if (event === 'settings')
                this.manifest.settings = { ...this.manifest.settings, ...value, goal: undefined };
            if (event === 'decisionScope') {
                this.manifest.decisionScope = value;
                return;
            }
            if (event === 'wire') {
                this.manifest.wire = value;
                return;
            }
            if (event === 'attempt') {
                if (this.manifest.attempts.length < 1000)
                    this.manifest.attempts.push(value);
                return;
            }
            const reference = this.manifest.mode === 'evidence' ? this.graph.pack(value) : undefined;
            if (event === 'questions')
                this.manifest.batches.push({ questionsHash: hash, questionsRef: reference });
            else if (event === 'response') {
                const response = value;
                const batch = this.manifest.batches.find(item => item.questionsHash === response.questionsHash && !item.responseHash);
                if (batch) {
                    batch.responseHash = digest(JSON.stringify(response.response));
                    batch.responseRef = reference;
                }
            }
            else if (reference)
                this.manifest.references[event] = reference;
        }
        catch (error) {
            this.gap(error);
        }
        finally {
            this.captureTime += performance.now() - start;
        }
    };
    gap(error) {
        const reason = error instanceof Error ? error.message : 'audit capture failed';
        if (!this.manifest.gaps.includes(reason))
            this.manifest.gaps.push(reason.slice(0, 180));
    }
    async finish(stage, reason, historyRecorded, output) {
        const finishStarted = performance.now();
        if (this.closed)
            return;
        if (output !== undefined) {
            this.observe('hostOutput', output);
            this.manifest.outputHash = digest(JSON.stringify(output));
        }
        this.closed = true;
        Object.assign(this.manifest, { stage, reason, historyRecorded, endedAt: new Date().toISOString() });
        try {
            await withAuditLock(this.env, async () => {
                try {
                    await persistGraph(this.env, this.graph, Math.max(0, this.quota - 128 * 1024));
                }
                catch (error) {
                    this.gap(error);
                }
                this.manifest.captureMs = this.captureTime + performance.now() - finishStarted;
                await reserveBytes(this.env, Buffer.byteLength(JSON.stringify(this.manifest)), this.quota);
                await atomicJson(join(auditRoot(this.env), 'evaluations', `${this.manifest.id}.json`), this.manifest);
            });
        }
        catch (error) {
            this.gap(error);
            await this.failureMarker();
        }
    }
    async failureMarker() {
        try {
            await atomicJson(join(auditRoot(this.env), 'last-failure.json'), { at: new Date().toISOString(), id: this.manifest.id, gaps: this.manifest.gaps });
        }
        catch { }
    }
}
export async function beginAudit(env, agent, id, messages, settings, sessionId, agentId, extra = { sessionSource: sessionId ? 'native' : 'unknown' }) {
    const beginStarted = performance.now();
    try {
        const config = await auditConfig(env), mode = config.agents[agent];
        if (!mode)
            return undefined;
        if (!validId(id))
            throw Error('invalid evaluation ID');
        let transcript, transcriptOffset;
        if (sessionId) {
            try {
                const binding = await readJson(join(auditRoot(env), 'sources', `${digest(`${agent}:${sessionId}:${agentId ?? ''}`)}.json`));
                transcript = binding.path;
                transcriptOffset = (await stat(transcript)).size;
            }
            catch { }
        }
        const seen = new Map();
        const outputsById = new Map();
        for (const message of messages)
            for (const output of message.toolResults ?? []) {
                const group = outputsById.get(output.callId) ?? [];
                group.push(output);
                outputsById.set(output.callId, group);
            }
        const calls = [];
        messages.forEach((message, index) => message.toolCalls.forEach(call => {
            const outputs = outputsById.get(call.id) ?? [];
            const occurrence = seen.get(call.id) ?? 0;
            seen.set(call.id, occurrence + 1);
            calls.push({ id: call.id, occurrence, inputHash: digest(inputText(call.input)), resultHashes: outputs.map(item => digest(item.output)), resultLengths: outputs.map(item => item.output.length), inputChars: inputText(call.input).length, messageIndex: index, isError: outputs.some(item => !!item.isError) });
        }));
        const manifest = {
            schema: 1, id, agent, sessionId, agentId, sessionSource: extra.sessionSource, adapterPolicy: extra.adapterPolicy, transcript, transcriptOffset,
            startedAt: new Date().toISOString(), mode, version: VERSION, build: await buildHash(), policy: 'conservative-head-tail-v2', stage: 'started',
            settings, hashes: {}, references: {}, batches: [], attempts: [], calls, gaps: [], beginMs: 0, captureMs: 0, observedInputHash: messageHash(messages),
        };
        if (!sessionId)
            manifest.gaps.push('native session identity unavailable');
        if ([...seen.values()].some(count => count > 1))
            manifest.gaps.push('duplicate native call identifiers');
        await withAuditLock(env, async () => {
            await reserveBytes(env, Buffer.byteLength(JSON.stringify(manifest)), config.maxBytes);
            await atomicJson(join(auditRoot(env), 'evaluations', `${id}.json`), manifest);
        });
        const capture = new AuditCapture(env, config.maxBytes, config.captureBytes, manifest);
        capture.observe('input', messages);
        manifest.beginMs = performance.now() - beginStarted;
        return capture;
    }
    catch (error) {
        try {
            await atomicJson(join(auditRoot(env), 'last-failure.json'), { at: new Date().toISOString(), id, reason: error instanceof Error ? error.message : 'audit initialization failed' });
        }
        catch { }
        return undefined;
    }
}
export async function bindAuditSource(env, agent, sessionId, path, agentId) {
    try {
        const config = await auditConfig(env);
        if (!config.agents[agent] || !sessionId || !path)
            return;
        const bindingPath = join(auditRoot(env), 'sources', `${digest(`${agent}:${sessionId}:${agentId ?? ''}`)}.json`);
        try {
            const existing = await readJson(bindingPath);
            if (existing.agent === agent && existing.sessionId === sessionId && existing.agentId === agentId && existing.path === path)
                return;
        }
        catch { }
        await withAuditLock(env, async () => {
            await reserveBytes(env, Buffer.byteLength(path) + 256, config.maxBytes);
            await atomicJson(bindingPath, { agent, sessionId, agentId, path });
        });
    }
    catch { }
}
export async function auditEvent(env, id, event, evidence) {
    if (!validId(id))
        return;
    try {
        const config = await auditConfig(env);
        await withAuditLock(env, async () => {
            await reserveBytes(env, 512, config.maxBytes);
            await atomicJson(join(auditRoot(env), 'events', `${id}.json`), { id, event, at: new Date().toISOString(), evidence });
        });
    }
    catch { }
}
export async function auditManifests(env) {
    const manifests = [], corrupt = [];
    for (const name of await readdir(join(auditRoot(env), 'evaluations')).catch(() => [])) {
        if (!name.endsWith('.json'))
            continue;
        try {
            const manifest = await readJson(join(auditRoot(env), 'evaluations', name));
            if (manifest.schema !== 1 || !validId(manifest.id) || name !== `${manifest.id}.json`)
                throw Error('invalid schema');
            manifests.push(manifest);
        }
        catch {
            corrupt.push(name);
        }
    }
    manifests.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return { manifests, corrupt };
}
