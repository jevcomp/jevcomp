import { open, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { auditRoot, digest, readJson, atomicJson, reserveBytes, auditConfig, withAuditLock } from './audit-store.js';
async function readExact(file, position, length) {
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
        const result = await file.read(buffer, read, length - read, position + read);
        if (!result.bytesRead)
            throw Error('source file ended before expected bytes');
        read += result.bytesRead;
    }
    return buffer;
}
async function findFiles(root, nameMatches, depth = 0) {
    if (depth > 6)
        return [];
    const matches = [];
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        const path = join(root, entry.name);
        if (entry.isDirectory())
            matches.push(...await findFiles(path, nameMatches, depth + 1));
        else if (entry.isFile() && nameMatches(entry.name))
            matches.push(path);
    }
    return matches;
}
export async function resolveTranscript(env, manifest) {
    if (manifest.transcript)
        return manifest.transcript;
    if (!manifest.sessionId)
        return undefined;
    try {
        const binding = await readJson(join(auditRoot(env), 'sources', `${digest(`${manifest.agent}:${manifest.sessionId}:${manifest.agentId ?? ''}`)}.json`));
        return binding.path;
    }
    catch { }
    if (manifest.agentId)
        return undefined;
    const root = manifest.agent === 'claude' ? join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects') : join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
    const matches = await findFiles(root, name => manifest.agent === 'claude' ? name === `${manifest.sessionId}.jsonl` : name.endsWith(`-${manifest.sessionId}.jsonl`));
    return matches.length === 1 ? matches[0] : undefined;
}
function normalizedEvents(row, manifest, location) {
    const at = typeof row.timestamp === 'string' ? row.timestamp : '';
    const base = { ...location, at };
    if (manifest.agent === 'claude') {
        if (row.sessionId && row.sessionId !== manifest.sessionId)
            return [];
        if (row.subtype === 'compact_boundary')
            return [{ ...base, kind: 'boundary' }];
        const content = row.message?.content;
        if (!Array.isArray(content))
            return [];
        const events = [];
        if (row.type === 'assistant')
            events.push({ ...base, kind: 'assistant_message', id: row.message?.id ?? row.uuid });
        for (const block of content) {
            if (block.type === 'tool_use')
                events.push({ ...base, kind: 'call', id: block.id, tool: block.name, inputHash: digest(JSON.stringify(block.input)) });
            if (block.type === 'tool_result') {
                const output = blockText(block.content);
                events.push({ ...base, kind: 'result', id: block.tool_use_id, outputHash: digest(output), chars: output.length });
            }
            if (block.type === 'text')
                events.push({ ...base, kind: 'text', textHashes: [digest(block.text ?? '')] });
        }
        return events;
    }
    if (row.type === 'compacted') {
        const replacement = row.payload?.replacement_history;
        const texts = Array.isArray(replacement) ? replacement.flatMap((item) => {
            if (item?.type !== 'message' || item.role !== 'assistant')
                return [];
            const content = item.content;
            return Array.isArray(content) ? content.filter((part) => typeof part.text === 'string').map((part) => part.text) : [];
        }) : [];
        return [{ ...base, kind: 'boundary', textHashes: texts.map((text) => digest(JSON.stringify(text))), encrypted: Array.isArray(replacement) && replacement.some((item) => item?.type === 'compaction' && typeof item.encrypted_content === 'string') }];
    }
    if (row.type !== 'response_item')
        return [];
    const item = row.payload;
    if (!item || typeof item !== 'object')
        return [];
    if (item.type === 'message') {
        const textHashes = Array.isArray(item.content) ? item.content.filter((block) => typeof block.text === 'string').map((block) => digest(block.text)) : [];
        return [{ ...base, kind: item.role === 'assistant' ? 'assistant_message' : 'text', id: item.id, textHashes }];
    }
    if (typeof item.type === 'string' && item.type.endsWith('_call'))
        return [{ ...base, kind: 'call', id: item.call_id ?? item.id, tool: item.name ?? item.type, inputHash: digest(typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.input ?? item.action)) }];
    if (typeof item.type === 'string' && item.type.endsWith('_output')) {
        const output = blockText(item.output);
        return [{ ...base, kind: 'result', id: item.call_id, outputHash: digest(output), chars: output.length }];
    }
    return [];
}
export function blockText(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content))
        return content.filter(block => block && typeof block.text === 'string').map(block => block.text).join('\n');
    return JSON.stringify(content) ?? '';
}
export async function indexTranscript(env, manifest) {
    const path = await resolveTranscript(env, manifest);
    if (!path || !manifest.sessionId)
        return undefined;
    const cachePath = join(auditRoot(env), 'indexes', `${digest(`${path}:${manifest.sessionId}`)}.json`);
    const file = await open(path, 'r');
    try {
        const size = (await file.stat()).size;
        const prefix = await readExact(file, 0, Math.min(size, 4096));
        const prefixHash = digest(prefix);
        let index;
        let existing = false;
        try {
            index = await readJson(cachePath);
            if (index.schema !== 1 || index.path !== path || index.offset > size || index.prefixHash !== prefixHash)
                throw Error('source changed');
            if (index.offset) {
                const tailLength = Math.min(index.offset, 4096);
                const tail = await readExact(file, index.offset - tailLength, tailLength);
                if (!index.tailHash || digest(tail) !== index.tailHash)
                    throw Error('source tail changed');
            }
            existing = true;
        }
        catch {
            index = { schema: 1, path, sessionId: manifest.sessionId, offset: 0, prefixHash, events: [], gaps: [], updatedAt: '' };
        }
        if (existing && index.offset === size)
            return index;
        let position = index.offset, pending = Buffer.alloc(0), pendingOffset = position;
        const ceiling = Math.min(size, position + 128 * 1024 ** 2);
        while (position < ceiling) {
            const buffer = Buffer.alloc(Math.min(64 * 1024, ceiling - position));
            const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
            if (!bytesRead)
                break;
            position += bytesRead;
            pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
            let newline;
            while ((newline = pending.indexOf(10)) >= 0) {
                const line = pending.subarray(0, newline + 1);
                try {
                    const row = JSON.parse(line.toString('utf8'));
                    if (manifest.agent === 'codex' && row.type === 'session_meta' && (row.payload?.id ?? row.payload?.session_id) !== manifest.sessionId)
                        throw Error('session identity mismatch');
                    index.events.push(...normalizedEvents(row, manifest, { offset: pendingOffset, length: line.length, hash: digest(line) }));
                }
                catch (error) {
                    if (error.message === 'session identity mismatch')
                        throw error;
                    if (!index.gaps.includes('unreadable source records'))
                        index.gaps.push('unreadable source records');
                }
                pendingOffset += line.length;
                pending = pending.subarray(newline + 1);
            }
            if (pending.length > 8 * 1024 ** 2 || index.events.length > 250_000) {
                index.gaps.push('source analysis budget reached');
                break;
            }
        }
        index.offset = pendingOffset;
        const tailLength = Math.min(index.offset, 4096);
        const tail = await readExact(file, index.offset - tailLength, tailLength);
        index.tailHash = digest(tail);
        index.updatedAt = new Date().toISOString();
        index.gaps = [...new Set(index.gaps.filter(gap => gap !== 'source tail not indexed'))];
        if (index.offset < size)
            index.gaps.push('source tail not indexed');
        const config = await auditConfig(env);
        await withAuditLock(env, async () => {
            await reserveBytes(env, Buffer.byteLength(JSON.stringify(index)), config.maxBytes);
            await atomicJson(cachePath, index);
        }).catch(() => { index.gaps.push('index cache not persisted'); });
        return index;
    }
    finally {
        await file.close();
    }
}
export async function sourceRecord(index, event) {
    if (!Number.isSafeInteger(event.offset) || event.offset < 0 || event.length > 8 * 1024 ** 2)
        throw Error('invalid source offset');
    const file = await open(index.path, 'r');
    try {
        const buffer = await readExact(file, event.offset, event.length);
        if (digest(buffer) !== event.hash)
            throw Error('source record replaced or unavailable');
        return JSON.parse(buffer.toString('utf8'));
    }
    finally {
        await file.close();
    }
}
export function sourceLabel(index) { return basename(index.path); }
