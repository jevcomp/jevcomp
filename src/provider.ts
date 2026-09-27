import { readFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

export type JevProvider = 'auto' | 'typesafe' | 'openrouter';
export type Env = Record<string, string | undefined>;

export interface JevClientOptions {
  auditObserver?: (event: string, value: unknown) => void;
  provider?: JevProvider;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  fetch?: typeof fetch;
  env?: Env;
  /** Cache serialization only when callers keep Jev state objects immutable between asks. */
  cacheStateSerialization?: boolean;
}

const DIRECT_URL = 'https://api.typesafe.ai/v1/systemone';
const OPENROUTER_URL = 'https://openrouter.ai/api/alpha/decisions';

export function configDir(env: Env = process.env): string {
  return env.JEVCOMP_CONFIG_DIR ?? join(homedir(), '.config', 'jevcomp');
}

export function defaultKeyPath(provider: Exclude<JevProvider, 'auto'>, env: Env = process.env): string {
  return join(configDir(env), provider === 'openrouter' ? 'openrouter_api_key' : 'typesafe_api_key');
}

export function providerPreferencePath(env: Env = process.env): string {
  return join(configDir(env), 'provider');
}

function savedProvider(env: Env): Exclude<JevProvider, 'auto'> | undefined {
  try {
    const value = String(readFileSync(providerPreferencePath(env), 'utf8')).trim().toLowerCase();
    return value === 'typesafe' || value === 'openrouter' ? value : undefined;
  } catch { return undefined; }
}

export async function saveProviderConfiguration(provider: Exclude<JevProvider, 'auto'>, apiKey: string, env: Env = process.env): Promise<{ keyFile: string; providerFile: string }> {
  const key = apiKey.trim();
  if (!key) throw new Error('API key cannot be empty');
  const dir = configDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try { await chmod(dir, 0o700); } catch {}
  const keyFile = defaultKeyPath(provider, env);
  const providerFile = providerPreferencePath(env);
  await writeFile(keyFile, `${key}\n`, { mode: 0o600 });
  await writeFile(providerFile, `${provider}\n`, { mode: 0o600 });
  try { await chmod(keyFile, 0o600); } catch {}
  try { await chmod(providerFile, 0o600); } catch {}
  return { keyFile, providerFile };
}

function readKey(paths: Array<string | undefined>): string {
  for (const path of paths) {
    if (!path) continue;
    try {
      const value = String(readFileSync(path, 'utf8')).trim();
      if (value) return value;
    } catch {}
  }
  return '';
}

/** Saves only the preferred provider, for switching to one whose key is already available. */
export async function savePreferredProvider(provider: Exclude<JevProvider, 'auto'>, env: Env = process.env): Promise<void> {
  const dir = configDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(providerPreferencePath(env), `${provider}\n`, { mode: 0o600 });
}

export interface KeyStatus { source: 'environment' | 'saved' | 'none'; variable?: string; ending?: string }

/** Says where the key for a provider comes from, showing only its last four characters. */
export function keyStatus(provider: Exclude<JevProvider, 'auto'>, env: Env = process.env): KeyStatus {
  const variable = provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'TYPESAFE_API_KEY';
  const ending = (key: string) => (key.length > 8 ? key.slice(-4) : undefined);
  if (env[variable]) return { source: 'environment', variable, ending: ending(env[variable]!) };
  const key = resolveApiKey(provider, { env });
  return key ? { source: 'saved', ending: ending(key) } : { source: 'none' };
}

export function hasSavedProviderKey(provider: Exclude<JevProvider, 'auto'>, env: Env = process.env): boolean {
  return savedProvider(env) === provider && !!readKey([defaultKeyPath(provider, env)]);
}

export function resolveApiKey(provider: Exclude<JevProvider, 'auto'>, options: Pick<JevClientOptions, 'apiKey' | 'env'> = {}): string {
  if (options.apiKey) return options.apiKey;
  const env = options.env ?? process.env;
  const preferred = env.JEVCOMP_PROVIDER ?? savedProvider(env);
  const genericKeyFile = preferred === provider ? env.JEVCOMP_KEY_FILE : undefined;
  if (provider === 'openrouter') {
    if (env.OPENROUTER_API_KEY) return env.OPENROUTER_API_KEY;
    return readKey([
      env.OPENROUTER_API_KEY_FILE,
      genericKeyFile,
      defaultKeyPath('openrouter', env),
    ]);
  }
  if (env.TYPESAFE_API_KEY) return env.TYPESAFE_API_KEY;
  return readKey([
    env.TYPESAFE_API_KEY_FILE,
    genericKeyFile,
    defaultKeyPath('typesafe', env),
    join(homedir(), '.typesafe_key'),
  ]);
}

export function resolveProvider(options: Pick<JevClientOptions, 'provider' | 'env' | 'apiKey'> = {}): Exclude<JevProvider, 'auto'> {
  const env = options.env ?? process.env;
  const requested = options.provider ?? (env.JEVCOMP_PROVIDER as JevProvider | undefined) ?? savedProvider(env) ?? 'auto';
  if (requested === 'typesafe' || requested === 'openrouter') return requested;
  if (options.apiKey) return 'typesafe';
  if (resolveApiKey('typesafe', { env })) return 'typesafe';
  if (resolveApiKey('openrouter', { env })) return 'openrouter';
  return 'typesafe';
}

export function providerConfig(options: JevClientOptions = {}): { provider: Exclude<JevProvider, 'auto'>; apiKey: string; model: string; baseUrl: string } {
  const env = options.env ?? process.env;
  const provider = resolveProvider(options);
  const apiKey = resolveApiKey(provider, options);
  const baseUrl = options.baseUrl ?? (provider === 'openrouter' ? env.OPENROUTER_JEV_URL ?? OPENROUTER_URL : env.JEV_BASE_URL ?? DIRECT_URL);
  const model = options.model ?? (provider === 'openrouter' ? env.OPENROUTER_JEV_MODEL ?? '~typesafe/jev-latest' : env.JEV_MODEL ?? 'jev-latest');
  return { provider, apiKey, model, baseUrl };
}

function parseResponse(status: number, ok: boolean, text: string): JevResponse {
  if (!ok) throw new Error(`Jev request failed (${status}): ${text.slice(0, 240)}`);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('Jev returned malformed JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Jev response is not an object');
  const response = parsed as Record<string, unknown>;
  if (!response.answers || typeof response.answers !== 'object' || Array.isArray(response.answers)) throw new Error('Jev response is missing answers');
  if (response.usage !== undefined) {
    if (!response.usage || typeof response.usage !== 'object' || Array.isArray(response.usage)) throw new Error('Jev usage is invalid');
    const usage = response.usage as Record<string, unknown>;
    for (const field of ['input_tokens', 'output_tokens']) {
      if (usage[field] !== undefined && (!Number.isInteger(usage[field]) || Number(usage[field]) < 0)) throw new Error(`Jev usage ${field} is invalid`);
    }
  }
  return response as unknown as JevResponse;
}

function retryable(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 524 || status === 529;
}

function headerDelay(response: Response): number | undefined {
  const milliseconds = response.headers?.get?.('retry-after-ms');
  if (milliseconds) {
    const parsed = Number(milliseconds);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  const value = response.headers?.get?.('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface ResolvedClient {
  provider: Exclude<JevProvider, 'auto'>;
  apiKey: string;
  model: string;
  url: string;
  timeout: number;
  retries: number;
  headers: Record<string, string>;
  fetcher: typeof fetch;
}

export class JevClient implements JevAsker {
  private resolved?: ResolvedClient;
  private readonly serializedStates = new WeakMap<object, string>();

  constructor(private readonly options: JevClientOptions = {}) {}

  private config(): ResolvedClient {
    if (this.resolved) return this.resolved;
    const env = this.options.env ?? process.env;
    const { provider, apiKey, model, baseUrl: url } = providerConfig(this.options);
    if (!apiKey) throw new Error(provider === 'openrouter' ? 'OPENROUTER_API_KEY is not configured' : 'TYPESAFE_API_KEY is not configured');
    const timeoutValue = this.options.timeoutMs ?? (env.JEVCOMP_TIMEOUT_MS?.trim() ? Number(env.JEVCOMP_TIMEOUT_MS) : 20_000);
    const retryValue = this.options.retries ?? (env.JEVCOMP_RETRIES?.trim() ? Number(env.JEVCOMP_RETRIES) : 1);
    const timeout = Number.isFinite(timeoutValue) ? Math.max(1, Math.floor(timeoutValue)) : 20_000;
    const retries = Number.isFinite(retryValue) ? Math.max(0, Math.floor(retryValue)) : 1;
    const headers: Record<string, string> = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
    if (provider === 'openrouter') {
      headers['x-openrouter-title'] = 'jevcomp';
      if (env.OPENROUTER_HTTP_REFERER) headers['http-referer'] = env.OPENROUTER_HTTP_REFERER;
    }
    return this.resolved = { provider, apiKey, model, url, timeout, retries, headers, fetcher: this.options.fetch ?? fetch };
  }

  private body(model: string, state: JevState, questions: JevQuestions): string {
    let stateJson: string | undefined;
    if (this.options.cacheStateSerialization) stateJson = this.serializedStates.get(state);
    if (!stateJson) {
      stateJson = JSON.stringify(state);
      if (this.options.cacheStateSerialization) this.serializedStates.set(state, stateJson);
    }
    return `{"model":${JSON.stringify(model)},"state":${stateJson},"questions":${JSON.stringify(questions)}}`;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    const { model, url, timeout, retries, headers, fetcher } = this.config();
    const body = this.body(model, state, questions);

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetcher(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeout) });
      } catch (error) {
        try { this.options.auditObserver?.('attempt', { attempt, failed: true }); } catch {}
        if (attempt >= retries) throw error;
        await sleep(Math.min(2_000, 200 * 2 ** attempt));
        continue;
      }
      const text = await response.text();
      try { this.options.auditObserver?.('attempt', { attempt, status: response.status }); } catch {}
      if (response.ok || attempt >= retries || !retryable(response.status)) return parseResponse(response.status, response.ok, text);
      await sleep(Math.min(2_000, headerDelay(response) ?? 200 * 2 ** attempt));
    }
  }
}

export function noul(answers: JevResponse['answers'], key: string): number {
  const answer = answers[key];
  if (answer?.type !== undefined && answer.type !== 'noul') throw new Error(`Invalid Jev answer type for ${key}`);
  const value = answer?.noul;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Invalid Jev answer for ${key}`);
  return value;
}
