import { spawn } from 'node:child_process';
export declare function commandExists(name: string): boolean;
export declare function runSync(name: string, args: readonly string[], options?: Record<string, unknown>): string;
export declare function launch(name: string, args: readonly string[], options: Record<string, unknown>, spawnFn?: typeof spawn): any;
