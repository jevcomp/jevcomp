import { renderMessages } from './render.js';
const CODEX_TURN_METADATA_KEY = 'x-codex-turn-metadata';
const CODEX_USER_MESSAGE_BUDGET_TOKENS = 20_000;
const CODEX_COMPACTION_PROMPT = [
    'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.',
    '',
    'Include:',
    '- Current progress and key decisions made',
    '- Important context, constraints, or user preferences',
    '- What remains to be done (clear next steps)',
    '- Any critical data, examples, or references needed to continue',
    '',
    'Be concise, structured, and focused on helping the next LLM seamlessly continue the work.',
    '',
].join('\n');
function record(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function turnMetadata(value) {
    const client = record(value.client_metadata) ? value.client_metadata : undefined;
    const raw = client?.[CODEX_TURN_METADATA_KEY];
    if (record(raw))
        return raw;
    if (typeof raw !== 'string' || !raw.trim())
        return undefined;
    try {
        const parsed = JSON.parse(raw);
        return record(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
export function codexTurnMetadata(value) {
    return record(value) ? turnMetadata(value) : undefined;
}
function metadataDecision(value) {
    const metadata = turnMetadata(value);
    if (!metadata || typeof metadata.request_kind !== 'string')
        return undefined;
    if (metadata.request_kind !== 'compaction')
        return false;
    const compaction = record(metadata.compaction) ? metadata.compaction : undefined;
    const implementation = compaction?.implementation;
    if (typeof implementation !== 'string')
        return undefined;
    return implementation === 'responses';
}
function matchesLegacyPrompt(value) {
    const input = value.input;
    if (!Array.isArray(input) || input.length === 0)
        return false;
    const last = input[input.length - 1];
    if (!record(last) || last.type !== 'message' || last.role !== 'user' || !Array.isArray(last.content) || last.content.length !== 1)
        return false;
    const content = last.content[0];
    return record(content) && content.type === 'input_text' && typeof content.text === 'string'
        && content.text.replace(/\r\n/g, '\n') === CODEX_COMPACTION_PROMPT;
}
export function isCodexCompactionRequest(value) {
    if (!record(value) || !Array.isArray(value.input) || value.input.length === 0)
        return false;
    const decision = metadataDecision(value);
    return decision ?? matchesLegacyPrompt(value);
}
function approxCodexTokens(text) {
    return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}
/**
 * Codex local compaction re-inserts recent user messages outside the summary,
 * up to a 20k-token budget. Only messages fully covered by that budget are
 * safe to omit from jevcomp's synthetic summary; the boundary message stays.
 */
export function codexPreservedUserMessages(messages) {
    let remaining = CODEX_USER_MESSAGE_BUDGET_TOKENS;
    const preserved = new Set();
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (message.role !== 'user' || !message.text.trim())
            continue;
        const tokens = approxCodexTokens(message.text);
        if (tokens > remaining)
            break;
        preserved.add(message);
        remaining -= tokens;
        if (remaining === 0)
            break;
    }
    return preserved;
}
function summaryMessages(messages) {
    const preserved = codexPreservedUserMessages(messages);
    return messages.filter((message) => message.role !== 'developer' &&
        message.role !== 'system' &&
        !preserved.has(message));
}
export function renderCodexCompactionSummary(messages) {
    return renderMessages(summaryMessages(messages));
}
/**
 * Measures the text jevcomp would actually return to Codex, not transcript
 * content that Codex preserves or re-injects outside the summary.
 */
export function codexCompactionReductionRatio(before, after) {
    const beforeChars = renderCodexCompactionSummary(before).length;
    if (!beforeChars)
        return 0;
    return (beforeChars - renderCodexCompactionSummary(after).length) / beforeChars;
}
