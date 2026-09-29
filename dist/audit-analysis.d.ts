import { type HistoryRow } from './store.js';
import { type AuditManifest } from './audit.js';
import { type SourceIndex, type SourceEvent } from './audit-sources.js';
import type { Env } from './provider.js';
import type { CallDecision, Message } from './types.js';
export interface AuditCase {
    id: string;
    evaluationId: string;
    callId: string;
    callKey: string;
    agent: string;
    tool: string;
    action: string;
    proposedAction: string;
    pinned: boolean;
    dropLoss: number | null;
    truncateLoss: number | null;
    ruleConforms: boolean | null;
    originalChars: number;
    resultChars: number;
    savedChars: number;
    application: string;
    tags: string[];
    observation: {
        coverage: string;
        eventsObserved: number;
        windows: Record<string, string>;
        matches: {
            kind: string;
            event: SourceEvent;
        }[];
        gaps: string[];
    };
}
export interface AuditAnalysis {
    manifests: AuditManifest[];
    rows: Map<string, HistoryRow>;
    cases: AuditCase[];
    sources: Map<string, SourceIndex | undefined>;
    corrupt: string[];
    agyReuseCount: number;
}
export declare function expectedAction(decision: CallDecision, manifest: AuditManifest, dropLimit?: number, truncateLimit?: number): CallDecision['action'] | undefined;
export declare function analyzeAudit(env: Env): Promise<AuditAnalysis>;
export declare function auditReport(analysis: AuditAnalysis, seed?: string, limit?: number): {
    schema: number;
    generatedAt: string;
    units: {
        text: string;
        continuation: string;
    };
    limitations: string[];
    coverage: {
        evaluations: number;
        corrupt: string[];
        partial: number;
        pending: number;
        missingHistory: number;
        unavailableSources: number;
    };
    policy: {
        checked: number;
        mismatches: string[];
        unknown: number;
    };
    counts: {
        decisions: number;
        uniqueCalls: number;
        allEvaluations: {
            [k: string]: number;
        };
        firstEvaluations: {
            [k: string]: number;
        };
        rejected: number;
    };
    shorteningFunnel: {
        unprotected: number;
        positiveSizeSavings: number;
        favorableRiskPair: number;
        accepted: number;
        applicationObserved: number;
    };
    riskInversions: number;
    reappearances: {
        cases: number;
        withObservedApplication: number;
    };
    application: {
        [k: string]: number;
    };
    decisionReuse: {
        agy: number;
    };
    hostProjection: {
        agy: number;
    };
    keptExcerptReused: number;
    providerUsage: {
        reportedEvaluations: number;
        evaluatedInputTokensReported: number;
        evaluatedOutputTokensReported: number;
        rejectedInputTokensReported: number;
        attemptsObserved: number;
    };
    localCaptureMilliseconds: {
        samples: number;
        median: number | null;
        p95: number | null;
        maximum: number | null;
    };
    sample: {
        seed: string;
        limit: number;
        selected: {
            id: string;
            reason: string;
        }[];
        excludedDecisions: number;
        representativeErrorRate: string;
    };
};
export declare function inspectAuditCase(env: Env, analysis: AuditAnalysis, id: string): Promise<{
    case: AuditCase;
    evaluation: {
        id: string;
        agent: import("./audit-store.js").AuditAgent;
        sessionId: string | undefined;
        sessionSource: "unknown" | "native" | "proxy";
        startedAt: string;
        stage: "failed" | "started" | "evaluated" | "result_produced" | "rejected";
        reason: string | undefined;
        settings: Record<string, unknown>;
        version: string;
        build: string;
        policy: "conservative-prefix-v1" | "conservative-head-tail-v2";
        adapterPolicy: "agy-preserve-call-result-only-v1" | undefined;
        decisionScope: {
            evaluated: string[];
            reused: {
                callId: string;
                stableKey: string;
                originAuditId?: string;
            }[];
            stableKeys: Record<string, string>;
            projections?: Record<string, {
                selected: string;
                applied: string;
                selectedSavedChars?: number;
            }>;
        } | undefined;
        wire: {
            inputHash: string;
            outputHash: string;
            inputBytes: number;
            outputBytes: number;
        } | undefined;
        gaps: string[];
    };
    before: Message[] | undefined;
    after: Message[] | undefined;
    nearbyMessages: {
        role: import("./types.js").Role;
        text: string;
    }[];
    jevContext: {
        instructions: any;
        goal: any;
        matchingEntries: any;
        fullStateReference: string | undefined;
    };
    later: ({
        record: any;
        kind: string;
        event: SourceEvent;
    } | {
        unavailable: boolean;
        kind: string;
        event: SourceEvent;
    })[];
    review: unknown;
    evidenceAvailable: boolean;
    reviewQuestions: string[];
}>;
export declare function simulateAudit(env: Env, analysis: AuditAnalysis, dropLimit: number, truncateLimit: number, minimum?: number): Promise<{
    scope: string;
    dropLimit: number;
    truncateLimit: number;
    minimum: number | undefined;
    results: ({
        id: string;
        status: string;
        before?: undefined;
        after?: undefined;
        reduction?: undefined;
        accepted?: undefined;
        rejection?: undefined;
        changes?: undefined;
    } | {
        id: string;
        before: number;
        after: number;
        reduction: number;
        accepted: boolean;
        rejection: string | undefined;
        changes: {
            callId: string;
            from: string;
            to: import("./types.js").DecisionAction | undefined;
        }[];
        status?: undefined;
    })[];
}>;
