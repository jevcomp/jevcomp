import { beginAudit, auditEvent } from './audit.js';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { launch } from './command.js';
import { compactMessages, estimateTokens } from './compact.js';
import { codexCompactionReductionRatio, isCodexCompactionRequest, renderCodexCompactionSummary } from './codex-compaction.js';
import { jevCompactOptions } from './hooks.js';
export { isCodexCompactionRequest } from './codex-compaction.js';
import { appendResponseItem } from './rollout.js';
import { userSettings } from './settings.js';
import { captureDirectory, tryAppendHistory } from './store.js';
const destinations = {
    chatgpt: 'https://chatgpt.com/backend-api/codex',
    api: 'https://api.openai.com/v1',
};
const hopByHopHeaders = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);
async function authRoute(env) {
    const codexHome = env.CODEX_HOME?.trim() || join(homedir(), '.codex');
    let auth;
    try {
        auth = JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'));
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return 'api';
        throw new Error('Could not read Codex auth.json');
    }
    const mode = String(auth.auth_mode ?? '').replace(/[_\s-]/g, '').toLowerCase();
    if (mode === 'apikey' || (auth.OPENAI_API_KEY && mode !== 'chatgpt'))
        return 'api';
    if (['chatgpt', 'chatgptauthtokens', 'headers', 'agentidentity', 'personaltoken', 'personalaccesstoken'].includes(mode))
        return 'chatgpt';
    return auth.tokens && !auth.OPENAI_API_KEY ? 'chatgpt' : 'api';
}
function routeForRequest(headers, fallback) {
    const accountId = headers['chatgpt-account-id'];
    return accountId && (!Array.isArray(accountId) || accountId.length > 0) ? 'chatgpt' : fallback;
}
function requestPath(url) {
    const parsed = new URL(url, 'http://127.0.0.1');
    const path = parsed.pathname === '/v1' ? '/' : parsed.pathname.startsWith('/v1/') ? parsed.pathname.slice(3) : parsed.pathname;
    return { path, search: parsed.search };
}
function forwardedRequestHeaders(request) {
    const blocked = new Set(hopByHopHeaders);
    for (const name of String(request.headers.connection ?? '').split(',')) {
        if (name.trim())
            blocked.add(name.trim().toLowerCase());
    }
    blocked.add('host');
    blocked.add('content-length');
    const headers = new Headers();
    for (const [name, raw] of Object.entries(request.headers)) {
        if (!blocked.has(name) && raw !== undefined)
            headers.set(name, Array.isArray(raw) ? raw.join(', ') : String(raw));
    }
    return headers;
}
async function requestBody(request) {
    const chunks = [];
    for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
}
async function captureBody(env, body) {
    const directory = captureDirectory(env, 'codex-capture');
    if (!directory)
        return;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, `${Date.now()}-${randomUUID()}.json`), body, { flag: 'wx', mode: 0o600 });
}
function copyResponseHeaders(upstream, response) {
    upstream.headers.forEach((value, name) => {
        if (!hopByHopHeaders.has(name) && name !== 'content-length' && name !== 'content-encoding')
            response.setHeader(name, value);
    });
    const cookies = upstream.headers.getSetCookie?.();
    if (cookies?.length)
        response.setHeader('set-cookie', cookies);
}
function waitForDrain(response) {
    return new Promise((resolve) => {
        const finish = () => {
            response.off('drain', finish);
            response.off('close', finish);
            response.off('error', finish);
            resolve();
        };
        response.once('drain', finish);
        response.once('close', finish);
        response.once('error', finish);
    });
}
async function streamResponse(upstream, response) {
    response.statusCode = upstream.status;
    if (upstream.statusText)
        response.statusMessage = upstream.statusText;
    copyResponseHeaders(upstream, response);
    response.flushHeaders();
    if (!upstream.body) {
        response.end();
        return;
    }
    const reader = upstream.body.getReader();
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done)
                break;
            if (response.destroyed) {
                await reader.cancel();
                return;
            }
            if (!response.write(chunk.value)) {
                await waitForDrain(response);
                if (response.destroyed) {
                    await reader.cancel();
                    return;
                }
            }
        }
        response.end();
    }
    finally {
        reader.releaseLock();
    }
}
function sendFailure(response, status, message) {
    if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
    }
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(message);
}
const MAX_COMPACTION_SUMMARY_TOKENS = 18_000;
function record(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function responseEvent(type, sequenceNumber, fields) {
    return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequenceNumber, ...fields })}\n\n`;
}
function compactSse(summary, outputTokens, model) {
    const responseId = `resp_${randomUUID()}`;
    const itemId = `msg_${randomUUID()}`;
    const createdAt = Math.floor(Date.now() / 1000);
    const outputItem = {
        id: itemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: summary }],
    };
    const responseModel = model ?? 'jevcomp';
    const completedResponse = {
        id: responseId,
        object: 'response',
        created_at: createdAt,
        status: 'completed',
        model: responseModel,
        output: [outputItem],
        usage: {
            input_tokens: 0,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens: outputTokens,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: outputTokens,
        },
    };
    const events = [
        responseEvent('response.created', 0, {
            response: { id: responseId, object: 'response', created_at: createdAt, status: 'in_progress', model: responseModel },
        }),
        responseEvent('response.output_item.done', 1, { output_index: 0, item: outputItem }),
        responseEvent('response.completed', 2, { response: completedResponse }),
    ].join('');
    return Buffer.from(events, 'utf8');
}
function metadataString(metadata, key) {
    const value = metadata[key];
    return typeof value === 'string' && value.trim() ? value : undefined;
}
async function localCompaction(body, env) {
    const request = JSON.parse(Buffer.from(body).toString('utf8'));
    if (!isCodexCompactionRequest(request))
        return undefined;
    const payload = request;
    const items = payload.input;
    const messages = [];
    for (const item of items.slice(0, -1))
        appendResponseItem(messages, item);
    const runId = randomUUID();
    const metadata = record(payload.client_metadata) ? payload.client_metadata : {};
    const sessionId = metadataString(metadata, 'session_id') ?? metadataString(metadata, 'thread_id');
    const jev = jevCompactOptions(env, 'codex');
    const minimum = userSettings(env, 'codex').minReductionRatio;
    const audit = await beginAudit(env, 'codex', runId, messages, { minReductionRatio: minimum, provider: jev.provider, model: jev.model, maxSummaryTokens: MAX_COMPACTION_SUMMARY_TOKENS }, sessionId);
    const localRun = {
        at: new Date().toISOString(), runId, ...(audit ? { auditId: runId } : {}), sessionId: sessionId ?? runId,
        turnId: metadataString(metadata, 'turn_id'), model: typeof payload.model === 'string' ? payload.model : undefined,
        provider: jev.provider, host: 'codex', phase: 'precompact',
    };
    try {
        if (messages.length < 2) {
            const recorded = await tryAppendHistory({ ...localRun, status: 'skipped', detail: 'conversation too short' }, env);
            await audit?.finish('rejected', 'conversation_too_short', recorded);
            return undefined;
        }
        const result = await compactMessages(messages, { ...jev, auditObserver: audit?.observe });
        const belowMinimum = codexCompactionReductionRatio(messages, result.messages) < minimum;
        const summary = belowMinimum ? '' : renderCodexCompactionSummary(result.messages);
        const outputTokens = belowMinimum ? 0 : estimateTokens(summary);
        const rejection = belowMinimum ? 'below_minimum' : !summary.trim() ? 'empty_output' : outputTokens > MAX_COMPACTION_SUMMARY_TOKENS ? 'output_too_large' : undefined;
        const recorded = await tryAppendHistory({ ...localRun, status: rejection ? 'skipped' : 'prepared', stats: result.stats, decisions: result.decisions, retainedChars: rejection ? undefined : summary.length, detail: rejection ?? 'Responses API compaction answered locally by Jev' }, env);
        if (rejection) {
            await audit?.finish('rejected', rejection, recorded);
            return undefined;
        }
        const sse = compactSse(summary, outputTokens, typeof payload.model === 'string' ? payload.model : undefined);
        const postRecorded = await tryAppendHistory({ ...localRun, phase: 'postcompact', status: 'restored', stats: result.stats, retainedChars: summary.length, injectedChars: 0, injectedPayloadChars: 0 }, env);
        if (!postRecorded)
            audit?.manifest.gaps.push('postcompact history not recorded');
        await audit?.finish('result_produced', 'response_prepared', recorded, summary);
        return { body: sse, auditId: audit?.manifest.id };
    }
    catch (error) {
        const recorded = await tryAppendHistory({ ...localRun, status: 'failed', detail: error instanceof Error ? error.message : String(error) }, env);
        await audit?.finish('failed', 'compaction_failed', recorded);
        throw error;
    }
}
export async function startCodexProxy(env = process.env, upstreams = destinations) {
    const fallbackRoute = await authRoute(env);
    const pendingAuditEvents = new Set();
    const server = createServer((request, response) => {
        void (async () => {
            const body = await requestBody(request);
            const { path, search } = requestPath(request.url ?? '/');
            if (request.method === 'POST' && path === '/responses') {
                try {
                    await captureBody(env, body);
                }
                catch { }
                let localResponse;
                try {
                    localResponse = await localCompaction(body, env);
                }
                catch { }
                if (localResponse) {
                    response.writeHead(200, {
                        'content-type': 'text/event-stream; charset=utf-8',
                        'cache-control': 'no-cache, no-transform',
                        connection: 'keep-alive',
                    });
                    const auditId = localResponse.auditId;
                    if (auditId)
                        response.once('finish', () => {
                            const pending = auditEvent(env, auditId, 'transport_finished', 'HTTP response finish; consumption unconfirmed');
                            pendingAuditEvents.add(pending);
                            void pending.finally(() => pendingAuditEvents.delete(pending));
                        });
                    response.end(localResponse.body);
                    return;
                }
            }
            const route = routeForRequest(request.headers, fallbackRoute);
            const target = `${upstreams[route].replace(/\/+$/, '')}${path}${search}`;
            const controller = new AbortController();
            response.once('close', () => {
                if (!response.writableEnded)
                    controller.abort();
            });
            request.once('aborted', () => controller.abort());
            try {
                const upstream = await fetch(target, {
                    method: request.method,
                    headers: forwardedRequestHeaders(request),
                    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body,
                    redirect: 'manual',
                    signal: controller.signal,
                });
                await streamResponse(upstream, response);
            }
            catch {
                sendFailure(response, 502, 'Upstream request failed');
            }
        })().catch(() => sendFailure(response, 502, 'Proxy request failed'));
    });
    await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once('error', onError);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', onError);
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === 'string')
        throw new Error('Could not determine proxy address');
    return {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        close: async () => {
            await new Promise((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
                server.closeAllConnections?.();
            });
            await Promise.allSettled([...pendingAuditEvents]);
        },
    };
}
export function codexArguments(baseUrl, args) {
    const [command, subcommand] = args;
    const insertionIndex = command === 'exec' || command === 'e'
        ? ['resume', 'review', 'fork'].includes(subcommand ?? '') ? 2 : 1
        : ['resume', 'review', 'fork'].includes(command ?? '') ? 1 : 0;
    const providerArgs = [
        '-c', 'model_provider="jevcomp"',
        '-c', 'model_providers.jevcomp.name="jevcomp"',
        '-c', `model_providers.jevcomp.base_url=${JSON.stringify(baseUrl)}`,
        '-c', 'model_providers.jevcomp.requires_openai_auth=true',
        '-c', 'model_providers.jevcomp.wire_api="responses"',
        '-c', 'model_providers.jevcomp.supports_websockets=false',
    ];
    return [
        '--no-daemon',
        ...args.slice(0, insertionIndex),
        ...providerArgs,
        ...args.slice(insertionIndex),
    ];
}
function signalExitCode(signal) {
    const codes = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGBREAK: 21 };
    return signal ? 128 + (codes[signal] ?? 1) : 1;
}
function childExit(child) {
    return new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        child.once('error', onError);
        child.once('close', (code, signal) => {
            child.off('error', onError);
            resolve(code ?? signalExitCode(signal));
        });
    });
}
export async function runCodex(args, env = process.env, options = {}) {
    try {
        await options.startDashboard?.();
    }
    catch { }
    let proxy;
    try {
        proxy = await startCodexProxy(env, options.upstreams);
    }
    catch (error) {
        console.error(`jevcomp proxy failed (${error instanceof Error ? error.message : String(error)}); starting plain Codex.`);
    }
    try {
        const child = launch('codex', proxy ? codexArguments(proxy.baseUrl, args) : [...args], {
            env,
            stdio: 'inherit',
            windowsHide: true,
        }, options.spawn ?? spawn);
        return await childExit(child);
    }
    finally {
        await proxy?.close();
    }
}
