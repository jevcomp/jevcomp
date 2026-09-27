import { spawn, execFileSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { connect as tcpConnect, createServer as createNetServer } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { captureDirectory } from './store.js';
import { randomUUID } from 'node:crypto';

export const AGY_HOSTS = ['cloudcode-pa.googleapis.com', 'daily-cloudcode-pa.googleapis.com'] as const;
const allowed = new Set<string>(AGY_HOSTS);
export const isAgyInterceptHost = (hostname: string): boolean => allowed.has(hostname.toLowerCase());
const caDir = (env: Record<string, string | undefined>) => join(env.JEVCOMP_AGY_HOME ?? join(homedir(), '.jevcomp', 'agy-ca'));

function openssl(args: string[], env: Record<string, string | undefined>): void {
  try { execFileSync('openssl', args, { stdio: 'ignore', windowsHide: true, env }); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error('openssl was not found; install it first (for example: winget install ShiningLight.OpenSSL.Light)');
    }
    throw error;
  }
}

export async function ensureAgyCertificate(env = process.env): Promise<{ directory: string; thumbprint: string }> {
  const directory = caDir(env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const caKey = join(directory, 'ca.key'), caCert = join(directory, 'ca.crt');
  const serverKey = join(directory, 'server.key'), serverCert = join(directory, 'server.crt');
  try { await Promise.all([readFile(caKey), readFile(caCert), readFile(serverKey), readFile(serverCert)]); }
  catch {
    openssl(['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-days', '3650', '-nodes', '-keyout', caKey, '-out', caCert, '-subj', '/CN=jevcomp Antigravity local CA'], env);
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
    const output = execFileSync('openssl', ['x509', '-in', join(caDir(env), 'ca.crt'), '-noout', '-fingerprint', '-sha1'], { encoding: 'utf8', windowsHide: true, env });
    return output.match(/=([A-F0-9:]{59})/i)?.[1].replace(/:/g, '').toUpperCase();
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

export async function uninstallAgyCa(env = process.env): Promise<void> {
  const thumbprint = await agyCertificateThumbprint(env);
  if (!thumbprint) return;
  execFileSync('certutil.exe', ['-user', '-delstore', 'Root', thumbprint], { stdio: 'ignore', windowsHide: false });
}

export async function startAgyProxy(env = process.env, options: { tunnelHost?: string; tunnelPort?: number; upstreamHost?: string; upstreamPort?: number; upstreamCa?: Uint8Array } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const { directory } = await ensureAgyCertificate(env);
  const key = await readFile(join(directory, 'server.key'));
  const cert = await readFile(join(directory, 'server.crt'));
  const http = createHttpServer((req: any, res: any) => {
    void (async () => {
      const hostname = (String(req.headers.host ?? '').split(':')[0] ?? '').toLowerCase();
      if (!allowed.has(hostname)) { res.writeHead(403); res.end(); return; }
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      if (req.method === 'POST' && req.url?.split('?')[0] === '/v1internal:streamGenerateContent') {
        const directory = captureDirectory(env, 'agy-capture');
        if (directory) try { await mkdir(directory, { recursive: true, mode: 0o700 }); await writeFile(join(directory, `${Date.now()}-${randomUUID()}.bin`), body, { mode: 0o600, flag: 'wx' }); } catch {}
      }
      const upstream = await import('node:https').then(({ request }) => new Promise<any>((resolve, reject) => {
        const forward = request({ hostname: options.upstreamHost ?? hostname, servername: hostname, port: options.upstreamPort ?? 443, ca: options.upstreamCa, method: req.method, path: req.url, headers: req.headers }, resolve);
        forward.once('error', reject); forward.end(body);
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

export async function runAgy(args: readonly string[], env = process.env, options: { spawn?: typeof spawn; isInstalled?: (thumbprint: string) => boolean; startProxy?: typeof startAgyProxy } = {}): Promise<number> {
  let proxy: Awaited<ReturnType<typeof startAgyProxy>> | undefined;
  try {
    const certificate = await ensureAgyCertificate(env);
    if (!(options.isInstalled ?? agyCaInstalled)(certificate.thumbprint)) throw new Error('Antigravity CA is not installed. Run `jevcomp install agy` first.');
    proxy = await (options.startProxy ?? startAgyProxy)(env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (/CA is not installed/.test(String(error))) throw error;
    console.error('jevcomp Antigravity proxy failed; starting agy without the local proxy.');
  }
  const childEnv = proxy ? { ...env, HTTPS_PROXY: proxy.url, https_proxy: proxy.url } : env;
  try {
    const child = (options.spawn ?? spawn)('agy', args, { env: childEnv, stdio: 'inherit', windowsHide: true });
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code: number | null, signal: string | null) => resolve(code ?? (signal ? 128 : 1)));
    });
  } finally { await proxy?.close(); }
}
