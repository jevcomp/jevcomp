import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from './store.js';
import { launch } from './command.js';

type Env = Record<string, string | undefined>;
type RequestFn = typeof httpRequest;

export interface ClaudeUsageRow {
  at: string;
  model?: string;
  path: string;
  statusCode: number;
  durationMs: number;
  inputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  outputTokens?: number;
}

function positiveInt(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function usageFrom(value: unknown): Partial<ClaudeUsageRow> {  if (!value || typeof value !== 'object') return {};
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
  model?: string;
  usage: Partial<ClaudeUsageRow> = {};

  push(chunk: any): void {
    this.buffer += chunk.toString('utf8');
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) break;
      const event = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      for (const line of event.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { this.observe(JSON.parse(data)); } catch {}
      }
    }
    if (this.buffer.length > 256_000) this.buffer = this.buffer.slice(-64_000);
  }  private observe(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const event = value as Record<string, unknown>;
    const message = event.message && typeof event.message === 'object' ? event.message as Record<string, unknown> : undefined;
    if (typeof message?.model === 'string') this.model = message.model;
    const next = usageFrom(message?.usage ?? event.usage);
    for (const [key, amount] of Object.entries(next)) {
      if (amount !== undefined) (this.usage as Record<string, unknown>)[key] = amount;
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

function forwardHeaders(headers: Record<string, any>): Record<string, any> {
  const out = { ...headers };
  delete out.host;
  delete out.connection;
  delete out['proxy-connection'];
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

export function claudeProxyUnsupportedReason(env: Env): string | undefined {
  if (env.CLAUDE_CODE_USE_BEDROCK === '1' || env.ANTHROPIC_BEDROCK_BASE_URL) return 'Bedrock routing is active';
  if (env.CLAUDE_CODE_USE_VERTEX === '1' || env.ANTHROPIC_VERTEX_BASE_URL) return 'Vertex routing is active';
  if (env.HTTP_PROXY || env.HTTPS_PROXY || env.http_proxy || env.https_proxy) return 'an HTTP(S) corporate proxy is already configured';
  return undefined;
}

export async function startClaudeProxy(env: Env = process.env) {
  const base = new URL(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('ANTHROPIC_BASE_URL must use http or https');
  const requestFn: RequestFn = base.protocol === 'https:' ? httpsRequest as RequestFn : httpRequest;
  const sockets = new Set<any>();

  const server = createServer((req: any, res: any) => {
    const started = Date.now();
    const target = upstreamUrl(base, req.url ?? '/');
    const forward = requestFn(target, { method: req.method, headers: forwardHeaders(req.headers) }, (upstream: any) => {
      const tap = new SseUsageTap();
      const canInspect = !upstream.headers['content-encoding'] &&
        String(upstream.headers['content-type'] ?? '').toLowerCase().includes('text/event-stream');
      res.writeHead(upstream.statusCode ?? 502, forwardHeaders(upstream.headers));
      if (canInspect) upstream.on('data', (chunk: any) => tap.push(Buffer.from(chunk)));
      upstream.once('end', () => {
        void appendUsage({
          at: new Date().toISOString(),
          model: tap.model,
          path: target.pathname,
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
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Claude proxy did not bind a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
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
  let proxy: Awaited<ReturnType<typeof startClaudeProxy>> | undefined;
  const unsupported = claudeProxyUnsupportedReason(env);
  if (!unsupported) {
    try { proxy = await (options.startProxy ?? startClaudeProxy)(env); }
    catch (error) {
      console.error(`jevcomp Claude gateway is off (${error instanceof Error ? error.message : String(error)}); starting plain Claude Code.`);
    }
  } else {
    console.error(`jevcomp Claude gateway is off (${unsupported}); starting Claude Code with the compaction hook only.`);
  }
  const childEnv = proxy ? { ...env, ANTHROPIC_BASE_URL: proxy.baseUrl } : env;
  try {
    const child = launch('claude', args, { env: childEnv, stdio: 'inherit', windowsHide: true }, options.spawn ?? spawn);
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code: number | null, signal: string | null) => resolve(code ?? (signal ? 128 : 1)));
    });
  } finally {
    await proxy?.close();
  }
}
