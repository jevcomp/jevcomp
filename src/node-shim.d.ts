declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  pid: number;
  execPath: string;
  platform: string;
  version: string;
  cwd(): string;
  kill(pid: number, signal?: number | string): boolean;
  exit(code?: number): never;
  exitCode?: number;
  stdin: any;
  stdout: any;
  stderr: any;
};
declare const Buffer: any;
declare module 'node:fs/promises' {
  export const readFile: any; export const writeFile: any; export const appendFile: any; export const open: any;
  export const mkdir: any; export const rename: any; export const copyFile: any; export const cp: any; export const chmod: any; export const rm: any; export const readdir: any; export const stat: any;
}
declare module 'node:fs' { export const cpSync: any; export const existsSync: any; export const readFileSync: any; export const readdirSync: any; export const writeFileSync: any; }
declare module 'node:path' { export const join: any; export const dirname: any; export const resolve: any; export const basename: any; export const isAbsolute: any; export const relative: any; export const sep: string; }
declare module 'node:os' { export const homedir: any; export const tmpdir: any; }
declare module 'node:http' { export const createServer: any; export const request: any; }
declare module 'node:net' { export const connect: any; export const createServer: any; }
declare module 'node:tls' { export const createServer: any; }
declare module 'node:https' { export const request: any; }
declare module 'node:url' { export const fileURLToPath: any; }
declare module 'node:crypto' { export const createHash: any; export const randomUUID: any; }
declare module 'node:child_process' { export const execFileSync: any; export const spawn: any; }
declare module 'node:readline/promises' { export const createInterface: any; }
declare module 'node:zlib' { export const gzipSync: any; export const gunzipSync: any; export const createGunzip: any; export const createBrotliDecompress: any; export const createInflate: any; }
declare module 'node:string_decoder' { export class StringDecoder { constructor(encoding?: string); write(buffer: any): string; end(buffer?: any): string; } }
