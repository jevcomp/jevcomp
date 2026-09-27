import { readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { auditConfig, auditRoot, atomicJson, configureAudit, digest, directoryBytes, readJson, reserveBytes, unpackEvidence, validHash, withAuditLock } from './audit-store.js';
import { analyzeAudit, auditReport, inspectAuditCase, simulateAudit } from './audit-analysis.js';
import { auditManifests } from './audit.js';
function agentName(value) {
    if (value !== 'codex' && value !== 'claude')
        throw Error('agent must be codex or claude');
    return value;
}
function option(args, name, fallback) {
    const position = args.indexOf(name);
    return position < 0 ? fallback : args[position + 1];
}
function numberOption(args, name, fallback, minimum, maximum) {
    const raw = option(args, name);
    if (raw === undefined)
        return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < minimum || value > maximum)
        throw Error(`${name} must be between ${minimum} and ${maximum}`);
    return value;
}
function display(value, limit = 16 * 1024) {
    const body = JSON.stringify(value, null, 2);
    if (body.length > limit)
        throw Error(`output is ${body.length} characters; use --max-chars ${body.length} to export the complete result`);
    console.log(body);
}
async function compactCase(env, id, maxChars, suppliedAnalysis) {
    const analysis = suppliedAnalysis ?? await analyzeAudit(env);
    const detail = await inspectAuditCase(env, analysis, id);
    const text = JSON.stringify(detail);
    if (text.length <= maxChars)
        return detail;
    const condensed = { ...detail, before: undefined, after: undefined, nearbyMessages: undefined, jevContext: { ...detail.jevContext, matchingEntries: undefined }, later: detail.later.map(item => ({ kind: item.kind, event: item.event })),
        omitted: { reason: 'case content exceeds export limit', originalChars: text.length, maxChars, retry: `jevcomp audit inspect ${id} --max-chars ${text.length}` } };
    return condensed;
}
function safeTarget(root, path) {
    const absoluteRoot = resolve(root), absolute = resolve(path);
    if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${sep}`))
        throw Error('audit path outside root');
    return absolute;
}
async function objectReferences(env, hashes) {
    const queue = [...hashes];
    while (queue.length) {
        const hash = queue.pop();
        if (!validHash(hash))
            continue;
        let node;
        try {
            const zlib = await import('node:zlib');
            const encoded = zlib.gunzipSync(await readFile(join(auditRoot(env), 'objects', `${hash}.gz`)));
            if (digest(encoded) !== hash)
                throw Error(`audit object ${hash} failed integrity check`);
            node = JSON.parse(encoded.toString('utf8'));
        }
        catch (error) {
            throw Error(`cannot prune: referenced evidence ${hash} unavailable (${error instanceof Error ? error.message : String(error)})`);
        }
        const children = Array.isArray(node.array) ? node.array.filter((value) => typeof value === 'string') : Array.isArray(node.object) ? node.object.map((entry) => entry[1]).filter((value) => typeof value === 'string') : [];
        for (const child of children)
            if (validHash(child) && !hashes.has(child)) {
                hashes.add(child);
                queue.push(child);
            }
    }
}
async function pruneAudit(env) {
    const root = auditRoot(env);
    return withAuditLock(env, async () => {
        const config = await auditConfig(env);
        const { manifests, corrupt } = await auditManifests(env);
        if (corrupt.length)
            throw Error(`cannot prune: ${corrupt.length} audit manifest(s) are corrupt`);
        const cutoff = Date.now() - config.retentionDays * 86400_000;
        const bySession = new Map();
        for (const manifest of manifests) {
            const key = `${manifest.agent}:${manifest.sessionId ?? manifest.id}:${manifest.agentId ?? ''}`;
            const rows = bySession.get(key) ?? [];
            rows.push(manifest);
            bySession.set(key, rows);
        }
        const expired = [...bySession.values()].filter(rows => rows.every(row => row.endedAt && Date.parse(row.endedAt) < cutoff));
        for (const rows of expired)
            for (const manifest of rows) {
                await rm(safeTarget(root, join(root, 'evaluations', `${manifest.id}.json`)), { force: true });
                await rm(safeTarget(root, join(root, 'events', `${manifest.id}.json`)), { force: true });
                for (const name of await readdir(join(root, 'reviews')).catch(() => []))
                    if (name.startsWith(`${manifest.id}_`))
                        await rm(safeTarget(root, join(root, 'reviews', name)), { force: true });
                if (manifest.sessionId)
                    await rm(safeTarget(root, join(root, 'sources', `${digest(`${manifest.agent}:${manifest.sessionId}:${manifest.agentId ?? ''}`)}.json`)), { force: true });
            }
        const kept = manifests.filter(manifest => !expired.some(rows => rows.includes(manifest)));
        const referenced = new Set();
        for (const manifest of kept) {
            for (const hash of Object.values(manifest.references))
                if (validHash(hash))
                    referenced.add(hash);
            for (const batch of manifest.batches)
                for (const hash of [batch.questionsRef, batch.responseRef])
                    if (hash && validHash(hash))
                        referenced.add(hash);
        }
        await objectReferences(env, referenced);
        let removedObjects = 0;
        for (const name of await readdir(join(root, 'objects')).catch(() => [])) {
            if (!name.endsWith('.gz'))
                continue;
            const hash = name.slice(0, -3);
            if (!referenced.has(hash)) {
                await rm(safeTarget(root, join(root, 'objects', name)), { force: true });
                removedObjects++;
            }
        }
        for (const name of await readdir(join(root, 'indexes')).catch(() => []))
            await rm(safeTarget(root, join(root, 'indexes', name)), { force: true });
        const actualBytes = await directoryBytes(root);
        await atomicJson(join(root, 'budget.json'), { reservedBytes: actualBytes });
        return { expiredSessions: expired.length, expiredEvaluations: manifests.length - kept.length, removedObjects, keptEvaluations: kept.length, corruptManifests: corrupt, bytes: actualBytes };
    });
}
export async function auditCommand(args, env = process.env) {
    const [command, ...rest] = args;
    if (!command || command === 'help') {
        console.log('jevcomp audit enable <codex|claude> --mode <metadata|evidence>\njevcomp audit disable <codex|claude>\njevcomp audit configure --max-mib 500 --days 30 --capture-mib 8\njevcomp audit status|report|inspect <case-id>|object <hash>|simulate|review <case-id>|export|prune');
        return;
    }
    if (command === 'enable') {
        const mode = option(rest, '--mode', 'evidence');
        if (mode !== 'evidence' && mode !== 'metadata')
            throw Error('mode must be metadata or evidence');
        const config = await configureAudit(env, agentName(rest[0]), mode);
        display({ agents: config.agents, root: auditRoot(env), note: 'Capture is opt-in, local, and may contain conversation content in evidence mode.' });
        return;
    }
    if (command === 'disable') {
        display((await configureAudit(env, agentName(rest[0]))).agents);
        return;
    }
    if (command === 'configure') {
        const config = await withAuditLock(env, async () => {
            const current = await auditConfig(env);
            const values = {
                maxBytes: Math.floor(numberOption(rest, '--max-mib', current.maxBytes / 1024 ** 2, 1, 10240) * 1024 ** 2),
                retentionDays: Math.floor(numberOption(rest, '--days', current.retentionDays, 1, 3650)),
                captureBytes: Math.floor(numberOption(rest, '--capture-mib', current.captureBytes / 1024 ** 2, 1, 256) * 1024 ** 2),
            };
            if (values.captureBytes > values.maxBytes)
                throw Error('capture budget exceeds storage quota');
            Object.assign(current, values);
            await atomicJson(join(auditRoot(env), 'config.json'), current);
            return current;
        });
        display(config);
        return;
    }
    if (command === 'status') {
        const config = await auditConfig(env), { manifests, corrupt } = await auditManifests(env);
        let failure;
        try {
            failure = await readJson(join(auditRoot(env), 'last-failure.json'));
        }
        catch { }
        display({ config, root: auditRoot(env), bytes: await directoryBytes(auditRoot(env)), evaluations: manifests.length,
            stages: Object.fromEntries(['started', 'evaluated', 'result_produced', 'rejected', 'failed'].map(stage => [stage, manifests.filter(item => item.stage === stage).length])),
            partial: manifests.filter(item => item.gaps.length).length, corrupt, lastFailure: failure });
        return;
    }
    if (command === 'prune') {
        display(await pruneAudit(env));
        return;
    }
    if (command === 'review') {
        const id = rest[0];
        if (!id || !/^[a-zA-Z0-9_-]+_\d+$/.test(id))
            throw Error('invalid case ID');
        const analysis = await analyzeAudit(env);
        const selected = analysis.cases.find(item => item.id === id);
        if (!selected)
            throw Error('audit case not found');
        const verdict = option(rest, '--verdict');
        const reason = option(rest, '--reason');
        if (!verdict || !['appropriate', 'questionable', 'harm_observed', 'inconclusive'].includes(verdict) || !reason?.trim())
            throw Error('review requires --verdict appropriate|questionable|harm_observed|inconclusive and --reason TEXT');
        const review = { schema: 1, caseId: id, evaluationId: selected.evaluationId, verdict, reason, at: new Date().toISOString(), author: 'local-user', evidence: selected.observation.matches.map(item => item.event.hash) };
        const config = await auditConfig(env);
        await withAuditLock(env, async () => {
            await reserveBytes(env, Buffer.byteLength(JSON.stringify(review)), config.maxBytes);
            await atomicJson(join(auditRoot(env), 'reviews', `${id}.json`), review);
        });
        display(review);
        return;
    }
    if (command === 'simulate') {
        const analysis = await analyzeAudit(env);
        const drop = numberOption(rest, '--drop', 0.5, 0, 1), truncate = numberOption(rest, '--truncate', drop, 0, 1);
        const minimum = option(rest, '--minimum');
        display(await simulateAudit(env, analysis, drop, truncate, minimum === undefined ? undefined : numberOption(rest, '--minimum', 0.15, 0, 1)), numberOption(rest, '--max-chars', 64 * 1024, 1024, 16 * 1024 ** 2));
        return;
    }
    if (command === 'report') {
        const analysis = await analyzeAudit(env);
        display(auditReport(analysis, option(rest, '--seed', 'jev-audit-v1'), numberOption(rest, '--cases', 30, 1, 100)), numberOption(rest, '--max-chars', 16 * 1024, 1024, 16 * 1024 ** 2));
        return;
    }
    if (command === 'inspect') {
        const id = rest[0];
        if (!id)
            throw Error('case ID required');
        const max = numberOption(rest, '--max-chars', 16 * 1024, 1024, 16 * 1024 ** 2);
        display(await compactCase(env, id, max), max);
        return;
    }
    if (command === 'object') {
        const hash = rest[0];
        if (!hash || !validHash(hash))
            throw Error('valid evidence hash required');
        const max = numberOption(rest, '--max-chars', 16 * 1024, 1024, 16 * 1024 ** 2);
        display(await unpackEvidence(env, hash, max), max);
        return;
    }
    if (command === 'export') {
        const max = numberOption(rest, '--max-chars', 64 * 1024, 1024, 16 * 1024 ** 2);
        const analysis = await analyzeAudit(env);
        const report = auditReport(analysis, option(rest, '--seed', 'jev-audit-v1'), numberOption(rest, '--cases', 15, 1, 100));
        const requested = option(rest, '--ids')?.split(',').filter(Boolean) ?? report.sample.selected.map(item => item.id);
        const cases = [];
        for (const id of requested)
            cases.push(await compactCase(env, id, Math.max(1024, Math.floor(max / Math.max(1, requested.length))), analysis));
        display({ report, cases, disclosure: 'Selected local conversation excerpts; inspect before sending to another AI.' }, max);
        return;
    }
    throw Error(`unknown audit command: ${command}`);
}
