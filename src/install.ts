import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { LEGACY_HOOK_TAG } from './legacy.js';

interface HookEntry { matcher?: string; hooks: Array<Record<string, unknown>> }
interface HookConfig { description?: string; hooks?: Record<string, HookEntry[]>; [key: string]: unknown }
const TAGS = ['--jevcomp', LEGACY_HOOK_TAG];

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : undefined;
}

async function loadHookConfig(path: string): Promise<{ config: HookConfig; existed: boolean }> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return { config: {}, existed: false };
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (error) { throw new Error(`Cannot update ${path}: existing hooks file is invalid JSON (${error instanceof Error ? error.message : String(error)})`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Cannot update ${path}: existing hooks file must contain a JSON object`);
  return { config: parsed as HookConfig, existed: true };
}

function oursHook(hook: Record<string, unknown>): boolean {
  return (
    TAGS.some((tag) => typeof hook.command === 'string' && hook.command.includes(tag)) ||
    TAGS.some((tag) => typeof hook.commandWindows === 'string' && hook.commandWindows.includes(tag)));
}

function ours(entry: HookEntry): boolean { return entry.hooks.some(oursHook); }

function withoutOurs(entry: HookEntry): HookEntry | undefined {
  const hooks = entry.hooks.filter((hook) => !oursHook(hook));
  return hooks.length ? { ...entry, hooks } : undefined;
}

function codexHome(env: Record<string, string | undefined>): string { return env.CODEX_HOME ?? join(homedir(), '.codex'); }


export function runtimeDir(env = process.env): string {
  return env.JEVCOMP_RUNTIME_DIR ?? join(codexHome(env), 'jevcomp', 'runtime');
}

export async function removeLegacyHooks(env = process.env): Promise<string> {
  const path = env.CODEX_HOOKS_FILE ?? join(codexHome(env), 'hooks.json');
  let loaded: { config: HookConfig; existed: boolean };
  try { loaded = await loadHookConfig(path); } catch (error) { throw error; }
  if (!loaded.existed) return path;
  const { config } = loaded;
  const before = JSON.stringify(config);
  if (config.hooks) for (const key of Object.keys(config.hooks)) config.hooks[key] = (config.hooks[key] ?? []).map(withoutOurs).filter((entry): entry is HookEntry => entry !== undefined);
  if (JSON.stringify(config) === before) return path;
  await copyFile(path, `${path}.bak.${Date.now()}`);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return path;
}
