import { beginAudit, auditEvent } from './audit.js';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { launch } from './command.js';
import { compactMessages, estimateTokens } from './compact.js';
import { codexCompactionReductionRatio, codexTurnMetadata, isCodexCompactionRequest, renderCodexCompactionSummary } from './codex-compaction.js';
import { jevCompactOptions } from './hooks.js';
export { isCodexCompactionRequest } from './codex-compaction.js';
import { activeRun, assignArm, recordJevTokens, recordUsage, sseTap } from './experiment.js';
import { appendResponseItem, UnsupportedCodexRolloutError } from './rollout.js';
import { userSettings } from './settings.js';
import { captureDirectory, tryAppendHistory } from './store.js';
import { ensureAgentProxy } from './agent-proxy-service.js';
import { VERSION } from './version.js';
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
/** Another tool (e.g. a local ChatGPT bridge) may own `openai_base_url`; bypassing it breaks its custom models. */
export async function codexDestinations(env) {
    const codexHome = env.CODEX_HOME?.trim() || join(homedir(), '.codex');
    let config;
    try {
        config = await readFile(join(codexHome, 'config.toml'), 'utf8');
    }
    catch {
        return destinations;
    }
    for (const line of config.split(/\r?\n/)) {
        if (/^\s*\[/.test(line))
            break;
        const match = /^\s*openai_base_url\s*=\s*(["'])(.+?)\1\s*(?:#.*)?$/.exec(line);
        if (match?.[2])
            return { chatgpt: match[2], api: match[2] };
    }
    return destinations;
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
async function streamResponse(upstream, response, tap) {
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
            tap?.push(chunk.value);
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
        tap?.end();
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
function codexSessionId(payload) {
    const metadata = record(payload.client_metadata) ? payload.client_metadata : {};
    const canonical = codexTurnMetadata(payload) ?? {};
    return metadataString(canonical, 'session_id') ?? metadataString(canonical, 'thread_id')
        ?? metadataString(metadata, 'session_id') ?? metadataString(metadata, 'thread_id');
}
function codexUsage(value) {
    if (!record(value) || value.type !== 'response.completed' || !record(value.response) || !record(value.response.usage))
        return undefined;
    const usage = value.response.usage;
    const total = Number(usage.input_tokens), output = Number(usage.output_tokens);
    const cached = Number(record(usage.input_tokens_details) ? usage.input_tokens_details.cached_tokens : 0) || 0;
    if (!Number.isFinite(total) || !Number.isFinite(output))
        return undefined;
    return { input: Math.max(0, total - cached), cached, cacheWrite: 0, output };
}
function nativeCompactionInput(items, result) {
    const actions = new Map(result.decisions.map((decision) => [decision.callId, decision.action]));
    const retainedResults = new Map(result.messages.flatMap((message) => message.toolResults ?? []).map((output) => [output.callId, output.output]));
    return items.flatMap((item) => {
        if (!record(item))
            return [item];
        const type = String(item.type);
        if (!type.endsWith('_call') && !type.endsWith('_output'))
            return [item];
        const callId = item.call_id ?? item.id;
        const action = typeof callId === 'string' ? actions.get(callId) : undefined;
        if (action === 'drop_call')
            return [];
        if (action !== 'truncate_result' || typeof callId !== 'string' || !type.endsWith('_output'))
            return [item];
        const field = 'output' in item ? 'output' : 'result' in item ? 'result' : 'content';
        const text = retainedResults.get(callId);
        if (text === undefined)
            return [item];
        return [{ ...item, [field]: Array.isArray(item[field]) ? [{ type: 'input_text', text }] : text }];
    });
}
async function localCompaction(body, env) {
    const request = JSON.parse(Buffer.from(body).toString('utf8'));
    if (!isCodexCompactionRequest(request))
        return undefined;
    const payload = request;
    const items = payload.input;
    const messages = [];
    const runId = randomUUID();
    const metadata = record(payload.client_metadata) ? payload.client_metadata : {};
    const canonicalMetadata = codexTurnMetadata(payload) ?? {};
    const sessionId = codexSessionId(payload);
    const jev = jevCompactOptions(env, 'codex');
    const minimum = userSettings(env, 'codex').minReductionRatio;
    let audit;
    const localRun = {
        at: new Date().toISOString(), runId, auditId: undefined, sessionId: sessionId ?? runId,
        turnId: metadataString(canonicalMetadata, 'turn_id') ?? metadataString(metadata, 'turn_id'), model: typeof payload.model === 'string' ? payload.model : undefined,
        provider: jev.provider, host: 'codex', phase: 'precompact',
    };
    const measured = await assignArm(env, 'codex', localRun.sessionId);
    if (measured?.arm === 'native') {
        await tryAppendHistory({ ...localRun, status: 'skipped', detail: 'gain measurement: this compaction was left to Codex' }, env);
        return undefined;
    }
    try {
        for (const item of items.slice(0, -1))
            appendResponseItem(messages, item, true);
        const mediaResults = messages.flatMap((message) => message.toolResults ?? []).filter((output) => output.preserve);
        if (mediaResults.length) {
            const callCounts = new Map();
            const resultCounts = new Map();
            for (const message of messages) {
                for (const call of message.toolCalls)
                    callCounts.set(call.id, (callCounts.get(call.id) ?? 0) + 1);
                for (const output of message.toolResults ?? [])
                    resultCounts.set(output.callId, (resultCounts.get(output.callId) ?? 0) + 1);
            }
            for (const output of mediaResults) {
                if (callCounts.get(output.callId) !== 1 || resultCounts.get(output.callId) !== 1)
                    throw new UnsupportedCodexRolloutError('non-text tool output has no unique paired call');
            }
        }
        audit = await beginAudit(env, 'codex', runId, messages, { minReductionRatio: minimum, provider: jev.provider, model: jev.model, maxSummaryTokens: MAX_COMPACTION_SUMMARY_TOKENS }, sessionId);
        if (audit)
            localRun.auditId = runId;
        if (messages.length < 2) {
            const recorded = await tryAppendHistory({ ...localRun, status: 'skipped', detail: 'conversation too short' }, env);
            await audit?.finish('rejected', 'conversation_too_short', recorded);
            return undefined;
        }
        const result = await compactMessages(messages, { ...jev, auditObserver: audit?.observe });
        await recordJevTokens(env, 'codex', measured?.unitId, result.stats.jevInputTokens, result.stats.jevOutputTokens);
        const belowMinimum = codexCompactionReductionRatio(messages, result.messages) < minimum;
        if (mediaResults.length && result.stats.charsAfter >= result.stats.charsBefore) {
            const recorded = await tryAppendHistory({ ...localRun, status: 'skipped', stats: result.stats, decisions: result.decisions, detail: 'no_text_cuts; original media left to native compaction' }, env);
            await audit?.finish('rejected', 'no_text_cuts', recorded);
            return undefined;
        }
        if (mediaResults.length && !belowMinimum) {
            const nativeBody = Buffer.from(JSON.stringify({ ...payload, input: nativeCompactionInput(items, result) }), 'utf8');
            const recorded = await tryAppendHistory({ ...localRun, status: 'prepared', stats: result.stats, decisions: result.decisions, detail: 'Jev pruned text tools; original media retained for native compaction' }, env);
            await audit?.finish('evaluated', 'native_compaction_pending', recorded);
            return {
                body: nativeBody, native: true, auditId: audit?.manifest.id,
                finish: async (error) => {
                    const postRecorded = await tryAppendHistory({ ...localRun, phase: 'postcompact', status: error ? 'failed' : 'restored', stats: result.stats, detail: error ?? 'Native model completed compaction of Jev-pruned history with original media' }, env);
                    await audit?.finish(error ? 'failed' : 'result_produced', error ? 'native_compaction_failed' : 'native_compaction_completed', recorded && postRecorded);
                },
            };
        }
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
export async function startCodexProxy(env = process.env, configuredUpstreams, serverOptions = {}) {
    const fallbackRoute = await authRoute(env);
    const upstreams = configuredUpstreams ?? await codexDestinations(env);
    const pendingAuditEvents = new Set();
    let localBaseUrl = '';
    const server = createServer((request, response) => {
        if (request.method === 'GET' && request.url === '/__jevcomp/health' && serverOptions.instanceId) {
            response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            response.end(JSON.stringify({ service: 'jevcomp-codex-proxy', pid: process.pid, instanceId: serverOptions.instanceId, url: localBaseUrl, build: serverOptions.build ?? '', config: serverOptions.config ?? '', version: VERSION }));
            return;
        }
        void (async () => {
            let body = await requestBody(request);
            let nativeCompaction;
            const { path, search } = requestPath(request.url ?? '/');
            let measuredTurn;
            if (request.method === 'POST' && path === '/responses' && await activeRun(env, 'codex')) {
                try {
                    const payload = JSON.parse(Buffer.from(body).toString('utf8'));
                    measuredTurn = { sessionId: codexSessionId(payload), model: typeof payload.model === 'string' ? payload.model : undefined, compaction: isCodexCompactionRequest(payload) };
                }
                catch { }
            }
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
                if (localResponse?.native) {
                    body = localResponse.body;
                    nativeCompaction = localResponse;
                }
                else if (localResponse) {
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
            let nativeCompleted = false;
            const finishNative = (error) => {
                if (nativeCompleted || !nativeCompaction?.finish)
                    return;
                nativeCompleted = true;
                const pending = nativeCompaction.finish(error).catch(() => { });
                pendingAuditEvents.add(pending);
                void pending.finally(() => pendingAuditEvents.delete(pending));
            };
            try {
                const upstream = await fetch(target, {
                    method: request.method,
                    headers: forwardedRequestHeaders(request),
                    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body,
                    redirect: 'manual',
                    signal: controller.signal,
                });
                if (!upstream.ok)
                    finishNative(`Native compaction returned HTTP ${upstream.status}`);
                let usage;
                const tap = measuredTurn?.sessionId || nativeCompaction ? sseTap((event) => {
                    usage = codexUsage(event) ?? usage;
                    if (!record(event))
                        return;
                    if (event.type === 'response.completed' && record(event.response) && event.response.status === 'completed')
                        finishNative();
                    else if (['response.failed', 'response.incomplete', 'error'].includes(String(event.type)))
                        finishNative(`Native compaction returned ${event.type}`);
                }) : undefined;
                // Codex may hang up right after `response.completed`, which aborts the stream before it ends normally.
                try {
                    await streamResponse(upstream, response, tap);
                }
                finally {
                    if (tap && measuredTurn)
                        await recordUsage(env, 'codex', measuredTurn.sessionId, usage, measuredTurn.model, measuredTurn.compaction);
                }
                finishNative('Native compaction ended without response.completed');
            }
            catch {
                finishNative('Native compaction transport failed');
                sendFailure(response, 502, 'Upstream request failed');
            }
        })().catch(() => sendFailure(response, 502, 'Proxy request failed'));
    });
    await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once('error', onError);
        server.listen(serverOptions.port ?? 0, '127.0.0.1', () => {
            server.off('error', onError);
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === 'string')
        throw new Error('Could not determine proxy address');
    localBaseUrl = `http://127.0.0.1:${address.port}`;
    return {
        baseUrl: `${localBaseUrl}/v1`,
        close: async () => {
            await new Promise((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
                server.closeAllConnections?.();
            });
            await Promise.allSettled([...pendingAuditEvents]);
        },
    };
}
async function codexHistoryProvider(env) {
    const codexHome = env.CODEX_HOME?.trim() || join(homedir(), '.codex');
    let config;
    try {
        config = await readFile(join(codexHome, 'config.toml'), 'utf8');
    }
    catch {
        return 'jevcomp';
    }
    for (const line of config.split(/\r?\n/)) {
        if (/^\s*\[/.test(line))
            break;
        const match = /^\s*model_provider\s*=\s*(["'])([\w-]+)\1\s*(?:#.*)?$/.exec(line);
        if (match?.[2])
            return ['openai', 'ollama', 'lmstudio'].includes(match[2]) ? 'jevcomp' : match[2];
    }
    return 'jevcomp';
}
export function codexArguments(baseUrl, args, providerId = 'jevcomp') {
    const [command, subcommand] = args;
    const insertionIndex = command === 'exec' || command === 'e'
        ? ['resume', 'review', 'fork'].includes(subcommand ?? '') ? 2 : 1
        : ['resume', 'review', 'fork'].includes(command ?? '') ? 1 : 0;
    const providerArgs = [
        '-c', `model_provider=${JSON.stringify(providerId)}`,
        '-c', `model_providers.${providerId}.name="jevcomp"`,
        '-c', `model_providers.${providerId}.base_url=${JSON.stringify(baseUrl)}`,
        '-c', `model_providers.${providerId}.requires_openai_auth=true`,
        '-c', `model_providers.${providerId}.wire_api="responses"`,
        '-c', `model_providers.${providerId}.supports_websockets=false`,
        '-c', `model_providers.${providerId}.capabilities.remote_compaction="unsupported"`,
    ];
    return [
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
    let ephemeralProxy = false;
    try {
        const upstreams = options.upstreams ?? await codexDestinations(env);
        if (options.startProxy) {
            proxy = await options.startProxy(env, upstreams);
            ephemeralProxy = true;
        }
        else {
            const config = JSON.stringify(upstreams);
            const stable = await ensureAgentProxy('codex', config, env);
            proxy = { baseUrl: `${stable.url}/v1` };
        }
    }
    catch (error) {
        console.error(`jevcomp proxy failed (${error instanceof Error ? error.message : String(error)}); starting plain Codex.`);
    }
    try {
        const child = launch('codex', proxy ? codexArguments(proxy.baseUrl, args, await codexHistoryProvider(env)) : [...args], {
            env,
            stdio: 'inherit',
            windowsHide: true,
        }, options.spawn ?? spawn);
        return await childExit(child);
    }
    finally {
        if (ephemeralProxy)
            await proxy?.close?.();
    }
}
