import type { Message } from './types.js';
export declare function appendResponseItem(messages: Message[], value: unknown): void;
export declare class UnsupportedCodexRolloutError extends Error {
    constructor(message: string);
}
export declare function parseCodexRollout(jsonl: string): Message[];
export declare function loadCodexRollout(path: string, chunkBytes?: number): Promise<Message[]>;
