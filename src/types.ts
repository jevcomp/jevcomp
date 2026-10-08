export type Role = 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'unknown';

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  callId: string;
  output: string;
  isError?: boolean;
}

export interface Message {
  role: Role;
  text: string;
  toolCalls: ToolCall[];
  toolResults?: ToolResult[];
}

export type JevInstruction = string | Record<string, unknown> | unknown[];

export interface JevNoulQuestion {
  type: 'noul';
  instructions: JevInstruction;
  criteria?: { true: JevInstruction; false: JevInstruction };
}

export type JevQuestions = Record<string, JevNoulQuestion>;
export type JevState = Record<string, unknown>;
export interface JevAnswer { type?: string; noul?: number }
export interface JevUsage { input_tokens?: number; output_tokens?: number }
export interface JevResponse { answers: Record<string, JevAnswer>; model?: string; usage?: JevUsage }
export interface JevAsker { ask(state: JevState, questions: JevQuestions, signal?: AbortSignal): Promise<JevResponse> }

export type DecisionAction = 'keep' | 'truncate_result' | 'drop_call';
export interface CallDecision {
  id: string;
  callId: string;
  name: string;
  inputPreview: string;
  dropLoss: number;
  truncateLoss: number;
  action: DecisionAction;
  resultChars: number;
  originalChars: number;
  savedChars: number;
  pinned: boolean;
}

export interface CompactStats {
  messagesBefore: number;
  messagesAfter: number;
  charsBefore: number;
  charsAfter: number;
  calls: number;
  kept: number;
  resultsTruncated: number;
  callsDropped: number;
  pinned: number;
  stateTokens: number;
  stateStage: string;
  requests: number;
  jevInputTokens: number;
  jevOutputTokens: number;
  /** Number of Jev requests whose response included provider usage counters. */
  jevUsageReportedRequests?: number;
  ms: number;
}

export interface CompactResult {
  messages: Message[];
  decisions: CallDecision[];
  stats: CompactStats;
}
