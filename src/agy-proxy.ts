import { spawn, execFileSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { connect as tcpConnect, createServer as createNetServer } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { captureDirectory, tryAppendHistory } from './store.js';
import { compactAgyRequest, createAgyCompactionState } from './agy-compact.js';
import { launch } from './command.js';
import { randomUUID } from 'node:crypto';

const CA_NAME = 'jevcomp Antigravity local CA';

export const AGY_HOSTS = ['cloudcode-pa.googleapis.com', 'daily-cloudcode-pa.googleapis.com'] as const;
const allowed = new Set<string>(AGY_HOSTS);
export const isAgyInterceptHost = (hostname: string): boolean => allowed.has(hostname.toLowerCase());
const caDir = (env: Record<string, string | undefined>) => join(env.JEVCOMP_AGY_HOME ?? join(homedir(), '.jevcomp', 'agy-ca'));

const OPENSSL_MISSING = 'openssl was not found; install it first (for example: winget install ShiningLight.OpenSSL.Light)';

function opensslCandidates(env: Record<string, string | undefined>): string[] {
  const explicit = env.JEVCOMP_OPENSSL?.trim();
  if (explicit) return [explicit];
  const candidates = ['openssl'];
  if (process.platform === 'win32') {
    const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files';
    candidates.push(
      join(programFiles, 'Git', 'mingw64', 'bin', 'openssl.exe'),
      join(programFiles, 'Git', 'usr', 'bin', 'openssl.exe'),
    );
  }
  return [...new Set(candidates)];
}

function opensslRun<T>(args: string[], env: Record<string, string | undefined>, options: Record<string, unknown>): T {
  let missing = false;
  for (const executable of opensslCandidates(env)) {
    try { return execFileSync(executable, args, { windowsHide: true, env, ...options }) as T; }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') { missing = true; continue; }
      throw error;
    }
  }
  if (missing) throw new Error(OPENSSL_MISSING);
  throw new Error(OPENSSL_MISSING);
}

function openssl(args: string[], env: Record<string, string | undefined>): void {
  opensslRun(args, env, { stdio: 'ignore' });
}

export async function ensureAgyCertificate(env = process.env): Promise<{ directory: string; thumbprint: string }> {
  const directory = caDir(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const caKey = join(directory, 'ca.key'), caCert = join(directory, 'ca.crt');
  const serverKey = join(directory, 'server.key'), serverCert = join(directory, 'server.crt');
  try { await Promise.all([readFile(caKey), readFile(caCert), readFile(serverKey), readFile(serverCert)]); }
  catch {
    openssl(['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-days', '3650', '-nodes', '-keyout', caKey, '-out', caCert, '-subj', `/CN=${CA_NAME}`], env);
    openssl(['req', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-keyout', serverKey, '-out', join(directory, 'server.csr'), '-subj', '/CN=cloudcode-pa.googleapis.com'], env);
    await writeFile(join(directory, 'server.ext'), `subjectAltName=DNS:${AGY_HOSTS.join(',DNS:')}\nextendedKeyUsage=serverAuth\n`);
    openssl(['x509', '-req', '-in', join(directory, 'server.csr'), '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-out', serverCert, '-days', '825', '-sha256', '-extfile', join(directory, 'server.ext')], env);
  }
  openssl(['x509', '-in', caCert, '-outform', 'DER', '-out', join(directory, 'ca.cer')], env);
  const thumbprint = await agyCertificateThumbprint(env);
  if (!thumbprint) throw new Error('Could not read Antigravity CA thumbprint');
  return { directory, thumbprint };
}

export async function agyCertificateThumbprint(env = process.env): Promise<string | undefined> {
  try {
    const output = opensslRun<string>(['x509', '-in', join(caDir(env), 'ca.crt'), '-noout', '-fingerprint', '-sha1'], env, { encoding: 'utf8' });
    return output.match(/=([A-F0-9:]{59})/i)?.[1]?.replace(/:/g, '').toUpperCase();
  } catch { return undefined; }
}

export function agyCaInstalled(thumbprint: string): boolean {
  try {
    const output = execFileSync('certutil.exe', ['-user', '-store', 'Root', thumbprint], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return output.toUpperCase().includes(thumbprint.toUpperCase());
  } catch { return false; }
}

export async function installAgyCa(env = process.env): Promise<void> {
  console.warn('Windows will show a certificate security warning. Confirm only if you trust this local jevcomp Antigravity CA.');
  const { directory } = await ensureAgyCertificate(env);
  execFileSync('certutil.exe', ['-user', '-addstore', 'Root', join(directory, 'ca.cer')], { stdio: 'ignore', windowsHide: false });
}

export async function uninstallAgyCa(): Promise<void> {
  if (process.platform !== 'win32') return;
  try { execFileSync('certutil.exe', ['-user', '-store', 'Root', CA_NAME], { stdio: 'ignore', windowsHide: true }); }
  catch { return; }
  execFileSync('certutil.exe', ['-user', '-delstore', 'Root', CA_NAME], { stdio: 'ignore', windowsHide: false });
}

export async function startAgyProxy(env = process.env, options: { tunnelHost?: string; tunnelPort?: number; upstreamHost?: string; upstreamPort?: number; upstreamCa?: Uint8Array } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const { directory } = await ensureAgyCertificate(env);
  const compactionState = createAgyCompactionState();
  const key = await readFile(join(directory, 'server.key'));
  const cert = await readFile(join(directory, 'server.crt'));
  const http = createHttpServer((req: any, res: any) => {
    void (async () => {
      const hostname = (String(req.headers.host ?? '').split(':')[0] ?? '').toLowerCase();
      if (!allowed.has(hostname)) { res.writeHead(403); res.end(); return; }
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      let outbound = body;
      const isGeneration = req.method === 'POST' && req.url?.split('?')[0] === '/v1internal:streamGenerateContent';
      if (isGeneration) {
        const directory = captureDirectory(env, 'agy-capture');
        if (directory) try { await mkdir(directory, { recursive: true, mode: 0o700 }); await writeFile(join(directory, `${Date.now()}-${randomUUID()}.bin`), body, { mode: 0o600, flag: 'wx' }); } catch {}
        try {
          const compacted = await compactAgyRequest(body, env, compactionState);
          if (compacted) {
            if (compacted.changed) outbound = Buffer.from(JSON.stringify(compacted.payload));
            if (compacted.providerAsked) {
              const runId = randomUUID();
              const base = {
                at: new Date().toISOString(),
                runId,
                sessionId: compacted.sessionId,
                model: typeof compacted.payload.model === 'string' ? compacted.payload.model : undefined,
                host: 'agy' as const,
                phase: 'precompact' as const,
              };
              const status = compacted.providerFailed ? 'failed' as const : compacted.changed ? 'prepared' as const : 'skipped' as const;
              await tryAppendHistory({
                ...base,
                status,
                stats: compacted.stats,
                decisions: compacted.decisions,
                retainedChars: compacted.changed ? compacted.stats.charsAfter : undefined,
                detail: compacted.providerFailed
                  ? 'Jev failed; Antigravity forwarded with only previously cached decisions'
                  : compacted.planUpdated
                    ? `Antigravity request reduced by ${Math.round(compacted.reductionRatio * 100)}%`
                    : 'Antigravity reduction below minimum; new decisions were not applied',
              }, env);
              if (compacted.planUpdated && compacted.changed) {
                await tryAppendHistory({
                  ...base,
                  at: new Date().toISOString(),
                  phase: 'postcompact',
                  status: 'restored',
                  stats: compacted.stats,
                  retainedChars: compacted.stats.charsAfter,
                  injectedChars: 0,
                  injectedPayloadChars: 0,
                  detail: 'Antigravity request forwarded with stable Jev-selected tool evidence',
                }, env);
              }
            }
          }
        } catch {}
      }
      const forwardHeaders = outbound === body ? req.headers : { ...req.headers, 'content-length': String(outbound.length) };
      if (outbound !== body) delete forwardHeaders['transfer-encoding'];
      const upstream = await import('node:https').then(({ request }) => new Promise<any>((resolve, reject) => {
        const forward = request({ hostname: options.upstreamHost ?? hostname, servername: hostname, port: options.upstreamPort ?? 443, ca: options.upstreamCa, method: req.method, path: req.url, headers: forwardHeaders }, resolve);
        forward.once('error', reject); forward.end(outbound);
      }));
      res.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(res);
    })().catch(() => { if (!res.headersSent) res.writeHead(502); res.end(); });
  });
  const tls = createTlsServer({ key, cert }, (socket: any) => http.emit('connection', socket));
  const clients = new Set<any>();
  const server = createNetServer((client: any) => {
    clients.add(client);
    client.once('close', () => clients.delete(client));
    let header: any = Buffer.alloc(0);
    const onData = (chunk: any) => {
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.off('data', onData);
      const line = header.subarray(0, end).toString('latin1').split('\r\n')[0] ?? '';
      const [, target = ''] = line.split(' ');
      const hostname = target.replace(/:\d+$/, '').toLowerCase();
      if (!line.startsWith('CONNECT ') || !hostname) { client.destroy(); return; }
      if (allowed.has(hostname)) {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const rest = header.subarray(end + 4);
        if (rest.length) client.unshift(rest);
        tls.emit('connection', client);
        return;
      }
      const upstream = tcpConnect(options.tunnelPort ?? 443, options.tunnelHost ?? hostname, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const rest = header.subarray(end + 4);
        if (rest.length) upstream.write(rest);
        client.pipe(upstream); upstream.pipe(client);
      });
      client.once('error', () => upstream.destroy()); upstream.once('error', () => client.destroy());
    };
    client.on('data', onData);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => error ? reject(error) : resolve());
      for (const client of clients) client.destroy();
    }),
  };
}

export async function runAgy(args: readonly string[], env = process.env, options: { spawn?: typeof spawn; isInstalled?: (thumbprint: string) => boolean; startProxy?: typeof startAgyProxy; startDashboard?: () => Promise<unknown> } = {}): Promise<number> {
  try { await options.startDashboard?.(); } catch {}
  let proxy: Awaited<ReturnType<typeof startAgyProxy>> | undefined;
  try {
    const certificate = await ensureAgyCertificate(env);
    if (!(options.isInstalled ?? agyCaInstalled)(certificate.thumbprint)) throw new Error('the jevcomp certificate is not installed; run `jevcomp install agy`');
    proxy = await (options.startProxy ?? startAgyProxy)(env);
  } catch (error) {
    console.error(`jevcomp Antigravity proxy is off (${error instanceof Error ? error.message : String(error)}); starting plain agy.`);
  }
  const childEnv = proxy ? { ...env, HTTPS_PROXY: proxy.url, https_proxy: proxy.url } : env;
  try {
    const child = launch('agy', args, { env: childEnv, stdio: 'inherit', windowsHide: true }, options.spawn ?? spawn);
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code: number | null, signal: string | null) => resolve(code ?? (signal ? 128 : 1)));
    });
  } finally { await proxy?.close(); }
}
