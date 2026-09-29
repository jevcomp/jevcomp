import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { dataDir } from './store.js';
import type { Env } from './provider.js';

export type AuditAgent = 'codex' | 'claude' | 'agy';
export type AuditMode = 'metadata' | 'evidence';
export interface AuditConfig {
  schema: 1;
  agents: Partial<Record<AuditAgent, AuditMode>>;
  modes?: Partial<Record<AuditAgent, AuditMode>>;
  maxBytes: number;
  retentionDays: number;
  captureBytes: number;
}
export const defaultAuditConfig = (): AuditConfig => ({ schema: 1, agents: {}, modes: {}, maxBytes: 500 * 1024 ** 2, retentionDays: 30, captureBytes: 8 * 1024 ** 2 });
export const auditRoot = (env: Env) => join(dataDir(env), 'audit');
export const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const validId = (id: string): boolean => /^[a-zA-Z0-9_-]{1,100}$/.test(id);
export const validHash = (id: string): boolean => /^[a-f0-9]{64}$/.test(id);

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export async function auditConfig(env: Env): Promise<AuditConfig> {
  try {
    const stored = await readJson<AuditConfig>(join(auditRoot(env), 'config.json'));
    if (stored.schema !== 1 || !stored.agents || typeof stored.agents !== 'object') throw Error('invalid audit configuration');
    for (const section of [stored.agents, stored.modes ?? {}]) for (const [agent, mode] of Object.entries(section)) {
      if ((agent !== 'codex' && agent !== 'claude' && agent !== 'agy') || (mode !== 'metadata' && mode !== 'evidence')) throw Error('invalid audit agent or mode');
    }
    for (const key of ['maxBytes', 'retentionDays', 'captureBytes'] as const) {
      if (!Number.isSafeInteger(stored[key]) || stored[key] <= 0) throw Error(`invalid audit ${key}`);
    }
    return stored;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return defaultAuditConfig();
    throw error;
  }
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const staging = `${path}.${randomUUID()}.pending`;
  try {
    await writeFile(staging, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(staging, path);
  } finally { await rm(staging, { force: true }).catch(() => {}); }
}

export async function withAuditLock<T>(env: Env, action: () => Promise<T>): Promise<T> {
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
    } catch (error) {
      if (acquired || (error as { code?: string }).code !== 'EEXIST') throw error;
      try {
        const owner = await readJson<{ pid: number }>(join(lock, 'owner.json'));
        if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); }
          catch (dead) {
            if ((dead as { code?: string }).code === 'ESRCH') await rm(lock, { recursive: true, force: true });
          }
        }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  if (!acquired) throw Error('audit writer busy; capture not persisted');
  try { return await action(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

export async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && entry.name !== 'write.lock') total += await directoryBytes(path);
    else if (entry.isFile()) total += (await stat(path)).size;
  }
  return total;
}

export async function reserveBytes(env: Env, count: number, limit: number): Promise<void> {
  const root = auditRoot(env), ledgerPath = join(root, 'budget.json');
  let allocated: number;
  try {
    const ledger = await readJson<{ reservedBytes: number }>(ledgerPath);
    if (!Number.isSafeInteger(ledger.reservedBytes) || ledger.reservedBytes < 0) throw Error('invalid audit budget');
    allocated = ledger.reservedBytes;
  } catch { allocated = await directoryBytes(root); }
  if (allocated + count > limit) throw Error('audit storage quota reached');
  await atomicJson(ledgerPath, { reservedBytes: allocated + count });
}

type Child = string | { inline: unknown };
type Packed = { scalar: unknown } | { array: Child[] } | { object: [string, Child][] };
export class EvidenceGraph {
  readonly objects = new Map<string, Uint8Array>();
  bytes = 0;
  private readonly identities = new WeakMap<object, string>();
  constructor(readonly limit: number) {}

  pack(value: unknown, depth = 0): string {
    if (depth > 100) throw Error('audit nesting limit reached');
    if (value && typeof value === 'object') {
      const existing = this.identities.get(value);
      if (existing) return existing;
    }
    const child = (item: unknown): Child => {
      if (item === null || item === undefined || typeof item === 'number' || typeof item === 'boolean' || (typeof item === 'string' && item.length <= 256)) return { inline: item ?? null };
      return this.pack(item, depth + 1);
    };
    let packed: Packed;
    if (Array.isArray(value)) packed = { array: value.map(child) };
    else if (value && typeof value === 'object') {
      packed = { object: Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, child(item)]) };
    } else packed = { scalar: value ?? null };
    const encoded = Buffer.from(JSON.stringify(packed));
    const hash = digest(encoded);
    if (!this.objects.has(hash)) {
      if (this.bytes + encoded.length > this.limit) throw Error('audit capture byte budget reached');
      this.bytes += encoded.length;
      this.objects.set(hash, gzipSync(encoded));
    }
    if (value && typeof value === 'object') this.identities.set(value, hash);
    return hash;
  }
}

export async function persistGraph(env: Env, graph: EvidenceGraph, limit: number): Promise<void> {
  const root = join(auditRoot(env), 'objects');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const missing: [string, Uint8Array][] = [];
  const entries = [...graph.objects];
  for (let start = 0; start < entries.length; start += 16) {
    const absent = await Promise.all(entries.slice(start, start + 16).map(async ([hash, bytes]): Promise<[string, Uint8Array] | undefined> => {
      try { await stat(join(root, `${hash}.gz`)); return undefined; }
      catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; return [hash, bytes]; }
    }));
    for (const entry of absent) if (entry) missing.push(entry);
  }
  await reserveBytes(env, missing.reduce((sum, [, bytes]) => sum + bytes.length, 0), limit);
  for (let start = 0; start < missing.length; start += 8) {
    await Promise.all(missing.slice(start, start + 8).map(async ([hash, bytes]) => {
      const path = join(root, `${hash}.gz`);
      const staging = `${path}.${randomUUID()}.pending`;
      try {
        await writeFile(staging, bytes, { flag: 'wx', mode: 0o600 });
        await rename(staging, path);
      } finally { await rm(staging, { force: true }).catch(() => {}); }
    }));
  }
}

export async function unpackEvidence(env: Env, hash: string, maxBytes = 32 * 1024 ** 2): Promise<unknown> {
  let expanded = 0;
  async function unpack(key: string, depth: number): Promise<unknown> {
    if (!validHash(key) || depth > 100) throw Error('invalid audit object reference');
    const encoded = gunzipSync(await readFile(join(auditRoot(env), 'objects', `${key}.gz`)), { maxOutputLength: maxBytes });
    expanded += encoded.length;
    if (expanded > maxBytes || digest(encoded) !== key) throw Error('audit object integrity or expansion limit failure');
    const node = JSON.parse(encoded.toString('utf8')) as Packed;
    if ('scalar' in node) return node.scalar;
    const valueOf = (child: Child) => typeof child === 'string' ? unpack(child, depth + 1) : child.inline;
    if ('array' in node) { const result = []; for (const child of node.array) result.push(await valueOf(child)); return result; }
    const result: Record<string, unknown> = Object.create(null);
    for (const [name, child] of node.object) result[name] = await valueOf(child);
    return result;
  }
  return unpack(hash, 0);
}

export async function configureAudit(env: Env, agent: AuditAgent, mode?: AuditMode, enabled = mode !== undefined): Promise<AuditConfig> {
  return withAuditLock(env, async () => {
    const config = await auditConfig(env);
    if (mode) (config.modes ??= {})[agent] = mode;
    else if (config.agents[agent]) (config.modes ??= {})[agent] = config.agents[agent];
    const selectedMode = mode ?? config.modes?.[agent] ?? 'evidence';
    if (enabled) config.agents[agent] = selectedMode;
    else delete config.agents[agent];
    await atomicJson(join(auditRoot(env), 'config.json'), config);
    return config;
  });
}
