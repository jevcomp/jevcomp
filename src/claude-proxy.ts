import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dataDir } from './store.js';
import { launch } from './command.js';
import { recordUsage } from './experiment.js';
import { claudeGatewayUrl, ensureClaudeGateway } from './claude-gateway-service.js';
import { VERSION } from './version.js';

type Env = Record<string, string | undefined>;
type RequestFn = typeof httpRequest;

export interface ClaudeUsageRow {
  at: string;
  model?: string;
  path: string;
  statusCode: number;
  durationMs: number;
  sessionId?: string;
  inputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  outputTokens?: number;
}

function positiveInt(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function usageFrom(value: unknown): Partial<ClaudeUsageRow> {
  if (!value || typeof value !== 'object') return {};
  const usage = value as Record<string, unknown>;
  return {
    inputTokens: positiveInt(usage.input_tokens),
    cacheCreationInputTokens: positiveInt(usage.cache_creation_input_tokens),
    cacheReadInputTokens: positiveInt(usage.cache_read_input_tokens),
    outputTokens: positiveInt(usage.output_tokens),
  };
}

class SseUsageTap {
  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');
  model?: string;
  usage: Partial<ClaudeUsageRow> = {};

  push(chunk: any): void {
    this.buffer += this.decoder.write(chunk);
    this.consume(false);
  }

  finish(): void {
    this.buffer += this.decoder.end();
    this.consume(true);
  }

  observe(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const event = value as Record<string, unknown>;
    const message = event.message && typeof event.message === 'object' ? event.message as Record<string, unknown> : undefined;
    const model = message?.model ?? event.model;
    if (typeof model === 'string') this.model = model;
    const next = usageFrom(message?.usage ?? event.usage);
    for (const [key, amount] of Object.entries(next)) {
      if (amount !== undefined) (this.usage as Record<string, unknown>)[key] = amount;
    }
  }

  private consume(final: boolean): void {
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) break;
      this.observeEvent(this.buffer.slice(0, match.index));
      this.buffer = this.buffer.slice(match.index + match[0].length);
    }
    if (final && this.buffer.trim()) {
      this.observeEvent(this.buffer);
      this.buffer = '';
    } else if (this.buffer.length > 256_000) {
      this.buffer = this.buffer.slice(-64_000);
    }
  }

  private observeEvent(event: string): void {
    for (const line of event.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { this.observe(JSON.parse(data)); } catch {}
    }
  }
}

async function appendUsage(row: ClaudeUsageRow, env: Env): Promise<void> {
  try {
    const root = dataDir(env);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await appendFile(join(root, 'claude-usage.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 });
  } catch {}
}

/** Older Claude Code builds only send the session inside `metadata.user_id`, near the end of the request body. */
function sessionFromMetadata(tail: string): string | undefined {
  return /session[_\\"]*(?:id)?[\\":\s]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(tail)?.[1];
}

function forwardHeaders(headers: Record<string, any>): Record<string, any> {
  const out = { ...headers };
  const connectionTokens = typeof headers.connection === 'string'
    ? headers.connection.split(',').map((value: string) => value.trim().toLowerCase()).filter(Boolean)
    : [];
  for (const name of [
    'host', 'connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
    ...connectionTokens,
  ]) delete out[name];
  return out;
}

function upstreamUrl(base: URL, incoming: string): URL {
  const requestUrl = new URL(incoming || '/', 'http://localhost');
  const root = base.pathname.replace(/\/$/, '');
  const target = new URL(base.toString());
  target.pathname = `${root}/${requestUrl.pathname.replace(/^\//, '')}`.replace(/\/{2,}/g, '/');
  target.search = requestUrl.search;
  return target;
}

function envEnabled(value: string | undefined): boolean {
  return !!value?.trim() && !/^(?:0|false|no|off)$/i.test(value.trim());
}

/**
 * A settings file's `env` beats the process environment in Claude Code, so a base URL set there would silently
 * bypass the gateway; it becomes the gateway's upstream and a `--settings` file points Claude back at the gateway.
 */
async function settingsBaseUrl(env: Env): Promise<string | undefined> {
  const home = env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  for (const path of [join(process.cwd(), '.claude', 'settings.local.json'), join(process.cwd(), '.claude', 'settings.json'), join(home, 'settings.json')]) {
    try {
      const value = JSON.parse(await readFile(path, 'utf8'))?.env?.ANTHROPIC_BASE_URL;
      if (typeof value === 'string' && value.trim()) return value.trim();
    } catch {}
  }
  return undefined;
}

export function claudeProxyUnsupportedReason(env: Env): string | undefined {
  if (envEnabled(env.CLAUDE_CODE_USE_BEDROCK) || env.ANTHROPIC_BEDROCK_BASE_URL) return 'Bedrock routing is active';
  if (envEnabled(env.CLAUDE_CODE_USE_VERTEX) || env.ANTHROPIC_VERTEX_BASE_URL) return 'Vertex routing is active';
  if (envEnabled(env.CLAUDE_CODE_USE_FOUNDRY) || env.ANTHROPIC_FOUNDRY_BASE_URL) return 'Microsoft Foundry routing is active';
  if (envEnabled(env.CLAUDE_CODE_USE_ANTHROPIC_AWS)) return 'Claude Platform on AWS routing is active';
  if (envEnabled(env.CLAUDE_CODE_USE_MANTLE)) return 'Bedrock Mantle routing is active';
  if (envEnabled(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST)) return 'provider routing is managed by the host';
  if (env.HTTP_PROXY || env.HTTPS_PROXY || env.http_proxy || env.https_proxy) return 'an HTTP(S) corporate proxy is already configured';
  return undefined;
}

export interface ClaudeProxyServerOptions {
  port?: number;
  instanceId?: string;
  build?: string;
}

export async function startClaudeProxy(env: Env = process.env, serverOptions: ClaudeProxyServerOptions = {}) {
  const base = new URL(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('ANTHROPIC_BASE_URL must use http or https');
  const requestFn: RequestFn = base.protocol === 'https:' ? httpsRequest as RequestFn : httpRequest;
  const sockets = new Set<any>();
  let localBaseUrl = '';

  const server = createServer((req: any, res: any) => {
    if (req.method === 'GET' && req.url === '/__jevcomp/health' && serverOptions.instanceId) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        service: 'jevcomp-claude-gateway',
        pid: process.pid,
        instanceId: serverOptions.instanceId,
        url: localBaseUrl,
        upstream: base.toString().replace(/\/$/, ''),
        build: serverOptions.build ?? '',
        version: VERSION,
      }));
      return;
    }
    const started = Date.now();
    const target = upstreamUrl(base, req.url ?? '/');
    const headerSession = req.headers['x-claude-code-session-id'];
    let sessionId = typeof headerSession === 'string' && headerSession ? headerSession : undefined;
    let bodyTail = '';
    if (!sessionId) req.on('data', (chunk: any) => { bodyTail = (bodyTail + Buffer.from(chunk).toString('latin1')).slice(-16_384); });
    const forward = requestFn(target, { method: req.method, headers: forwardHeaders(req.headers) }, (upstream: any) => {
      const tap = new SseUsageTap();
      const contentType = String(upstream.headers['content-type'] ?? '').toLowerCase();
      const inspectable = !upstream.headers['content-encoding'];
      const inspectSse = inspectable && contentType.includes('text/event-stream');
      const inspectJson = inspectable && contentType.includes('application/json');
      const jsonChunks: any[] = [];
      let jsonBytes = 0;
      let jsonOverflow = false;
      res.writeHead(upstream.statusCode ?? 502, forwardHeaders(upstream.headers));
      upstream.on('data', (chunk: any) => {
        const bytes = Buffer.from(chunk);
        if (inspectSse) tap.push(bytes);
        if (inspectJson && !jsonOverflow) {
          jsonBytes += bytes.length;
          if (jsonBytes <= 8 * 1024 * 1024) jsonChunks.push(bytes);
          else { jsonOverflow = true; jsonChunks.length = 0; }
        }
      });
      upstream.once('end', () => {
        if (inspectSse) tap.finish();
        if (inspectJson && !jsonOverflow && jsonChunks.length) {
          try { tap.observe(JSON.parse(Buffer.concat(jsonChunks).toString('utf8'))); } catch {}
        }
        sessionId ??= sessionFromMetadata(bodyTail);
        if (tap.usage.inputTokens !== undefined || tap.usage.outputTokens !== undefined) {
          void recordUsage(env, 'claude', sessionId, {
            input: tap.usage.inputTokens ?? 0,
            cached: tap.usage.cacheReadInputTokens ?? 0,
            cacheWrite: tap.usage.cacheCreationInputTokens ?? 0,
            output: tap.usage.outputTokens ?? 0,
          }, tap.model);
        }
        void appendUsage({
          at: new Date().toISOString(),
          model: tap.model,
          path: target.pathname,
          ...(sessionId ? { sessionId } : {}),
          statusCode: upstream.statusCode ?? 0,
          durationMs: Date.now() - started,
          ...tap.usage,
        }, env);
      });
      upstream.pipe(res);
    });
    forward.once('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.once('aborted', () => forward.destroy());
    req.pipe(forward);
  });
  server.on('connection', (socket: any) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(serverOptions.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Claude proxy did not bind a TCP port');
  localBaseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl: localBaseUrl,
    upstream: base.toString(),
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}export async function runClaude(
  args: readonly string[],
  env: Env = process.env,
  options: {
    spawn?: typeof spawn;
    startProxy?: typeof startClaudeProxy;
    startDashboard?: () => Promise<unknown>;
  } = {},
): Promise<number> {
  try { await options.startDashboard?.(); } catch {}
  let proxy: Awaited<ReturnType<typeof startClaudeProxy>> | { baseUrl: string; upstream: string; close?: () => Promise<void> } | undefined;
  let ephemeralProxy = false;
  const unsupported = claudeProxyUnsupportedReason(env);
  const configuredBase = await settingsBaseUrl(env);
  if (!unsupported) {
    try {
      if (options.startProxy) {
        proxy = await options.startProxy(configuredBase ? { ...env, ANTHROPIC_BASE_URL: configuredBase } : env);
        ephemeralProxy = true;
      } else {
        const stableUrl = claudeGatewayUrl(env);
        const requestedUpstream = configuredBase ?? env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
        const upstream = requestedUpstream.replace(/\/$/, '') === stableUrl ? 'https://api.anthropic.com' : requestedUpstream;
        const stable = await ensureClaudeGateway(upstream, env);
        proxy = { baseUrl: stable.url, upstream: stable.upstream };
      }
    } catch (error) {
      console.error(`jevcomp Claude gateway is off (${error instanceof Error ? error.message : String(error)}); starting plain Claude Code.`);
    }
  } else {
    console.error(`jevcomp Claude gateway is off (${unsupported}); starting Claude Code with the compaction hook only.`);
  }
  const childEnv = proxy ? { ...env, ANTHROPIC_BASE_URL: proxy.baseUrl } : env;
  let override: string | undefined;
  try {
    if (proxy && configuredBase) {
      override = join(dataDir(env), `claude-gateway-${randomUUID()}.json`);
      await mkdir(dataDir(env), { recursive: true, mode: 0o700 });
      await writeFile(override, JSON.stringify({ env: { ANTHROPIC_BASE_URL: proxy.baseUrl } }), { mode: 0o600 });
    }
    const childArgs = override ? ['--settings', override, ...args] : args;
    const child = launch('claude', childArgs, { env: childEnv, stdio: 'inherit', windowsHide: true }, options.spawn ?? spawn);
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code: number | null, signal: string | null) => resolve(code ?? (signal ? 128 : 1)));
    });
  } finally {
    if (ephemeralProxy) await proxy?.close?.();
    if (override) await rm(override, { force: true }).catch(() => {});
  }
}
