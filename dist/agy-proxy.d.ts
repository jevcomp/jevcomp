import { spawn } from 'node:child_process';
export declare const AGY_HOSTS: readonly ["cloudcode-pa.googleapis.com", "daily-cloudcode-pa.googleapis.com"];
export declare const isAgyInterceptHost: (hostname: string) => boolean;
export declare function ensureAgyCertificate(env?: Record<string, string | undefined>): Promise<{
    directory: string;
    thumbprint: string;
}>;
export declare function agyCertificateThumbprint(env?: Record<string, string | undefined>): Promise<string | undefined>;
export declare function agyCaInstalled(thumbprint: string): boolean;
export declare function installAgyCa(env?: Record<string, string | undefined>): Promise<void>;
export declare function uninstallAgyCa(env?: Record<string, string | undefined>): Promise<void>;
export declare function startAgyProxy(env?: Record<string, string | undefined>, options?: {
    tunnelHost?: string;
    tunnelPort?: number;
    upstreamHost?: string;
    upstreamPort?: number;
    upstreamCa?: Uint8Array;
}): Promise<{
    url: string;
    close: () => Promise<void>;
}>;
export declare function runAgy(args: readonly string[], env?: Record<string, string | undefined>, options?: {
    spawn?: typeof spawn;
    isInstalled?: (thumbprint: string) => boolean;
    startProxy?: typeof startAgyProxy;
}): Promise<number>;
