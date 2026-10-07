type Env = Record<string, string | undefined>;
export type ExperimentAgent = 'codex' | 'claude' | 'agy';
export type Arm = 'jev' | 'native';
/** `input` excludes cache reads and cache writes. */
export interface TokenUsage {
    input: number;
    cached: number;
    cacheWrite: number;
    output: number;
}
export interface ExperimentResult {
    startedAt: string;
    finishedAt: string;
    samples: Record<Arm, number>;
    meanCost: Record<Arm, number>;
    savingRatio: number;
    interval: [number, number];
    verdict: 'gain' | 'loss' | 'no_difference';
    jevTokens: {
        input: number;
        output: number;
    };
}
export interface ExperimentProgress {
    active: boolean;
    startedAt?: string;
    samples: Record<Arm, number>;
    pending: number;
    needed: number;
    progress: number;
    done: boolean;
    estimate?: Omit<ExperimentResult, 'startedAt' | 'finishedAt'>;
    lastResult?: ExperimentResult;
}
/** Relative prices per token, normalized to uncached input; typical of current Anthropic, OpenAI and Gemini tariffs. */
export declare const COST_WEIGHTS: {
    readonly input: 1;
    readonly cached: 0.1;
    readonly cacheWrite: 1.25;
    readonly output: 5;
};
export declare function activeRun(env: Env, agent: ExperimentAgent): Promise<string | undefined>;
export declare function startExperiment(env: Env, agent: ExperimentAgent): Promise<void>;
export declare function stopExperiment(env: Env, agent: ExperimentAgent, result?: ExperimentResult): Promise<void>;
/** Evaluates the running measurement; once the verdict is settled it is saved and the measurement switches itself off. */
export declare function experimentProgress(env: Env, agent: ExperimentAgent): Promise<ExperimentProgress>;
/**
 * Codex and Claude draw one arm per compaction; Antigravity has no compaction moment, so the whole session shares one.
 * Undefined means no measurement is running and Jev acts as usual.
 */
export declare function assignArm(env: Env, agent: ExperimentAgent, sessionId: string): Promise<{
    arm: Arm;
    unitId: string;
} | undefined>;
/** Feeds every JSON `data:` payload of a server-sent event stream to `onData`, tolerating chunk boundaries anywhere. */
export declare function sseTap(onData: (value: unknown) => void): {
    push(chunk: Uint8Array): void;
    end(): void;
};
export declare function recordUsage(env: Env, agent: ExperimentAgent, sessionId: string | undefined, usage: TokenUsage | undefined, model?: string, compaction?: boolean): Promise<void>;
/** Claude Code summarizes by itself whenever Jev's cut is not applied; that summary is then the compaction cost. */
export declare function recordFallback(env: Env, agent: ExperimentAgent, unitId: string | undefined): Promise<void>;
export declare function recordJevTokens(env: Env, agent: ExperimentAgent, unitId: string | undefined, input: number | undefined, output: number | undefined): Promise<void>;
export {};
