export function toJevMessages(messages) {
    return messages.map((message) => ({
        role: message.role,
        text: message.text,
        toolCalls: message.toolUses.map((use) => ({ id: use.tool_use_id, name: use.tool, input: use.input })),
        ...(message.toolResults?.length ? { toolResults: message.toolResults.map((result) => ({ callId: result.tool_use_id, output: result.text, isError: result.isError })) } : {}),
    }));
}
/** Serialized Claude hook payload size, excluding internal handles that are not model context. */
export function claudeMessageChars(messages) {
    const serializable = messages.map((message) => {
        const { handle: _handle, ...rest } = message;
        return rest;
    });
    try {
        return JSON.stringify(serializable).length;
    }
    catch {
        return 0;
    }
}
/** Refine a requested cut against host fields jevcomp does not understand. */
export function safeJevCut(messages, cut) {
    const requestedDropped = new Set(cut.dropped);
    const protectedIds = new Set();
    for (const message of messages) {
        const unknownMessageKeys = Object.keys(message).filter((key) => !['role', 'text', 'toolUses', 'toolResults', 'handle'].includes(key));
        if (!unknownMessageKeys.length || message.text.trim())
            continue;
        const uses = message.toolUses ?? [];
        const results = message.toolResults ?? [];
        const hasToolItems = uses.length + results.length > 0;
        const allWouldDrop = hasToolItems &&
            uses.every((use) => requestedDropped.has(use.tool_use_id)) &&
            results.every((result) => requestedDropped.has(result.tool_use_id));
        if (allWouldDrop) {
            for (const use of uses)
                protectedIds.add(use.tool_use_id);
            for (const result of results)
                protectedIds.add(result.tool_use_id);
        }
    }
    let dropped = [...requestedDropped].filter((id) => !protectedIds.has(id));
    const droppedSet = new Set(dropped);
    const anyMessageSurvives = messages.some((message) => {
        const remainingUses = message.toolUses.filter((use) => !droppedSet.has(use.tool_use_id));
        const remainingResults = (message.toolResults ?? []).filter((result) => !droppedSet.has(result.tool_use_id));
        const touched = remainingUses.length !== message.toolUses.length || remainingResults.length !== (message.toolResults?.length ?? 0);
        if (!touched)
            return true;
        const unknownMessageKeys = Object.keys(message).filter((key) => !['role', 'text', 'toolUses', 'toolResults', 'handle'].includes(key));
        return !!message.text.trim() || remainingUses.length > 0 || remainingResults.length > 0 || unknownMessageKeys.length > 0;
    });
    if (!anyMessageSurvives)
        dropped = [];
    return { dropped, truncated: cut.truncated };
}
/** Messages Jev left alone go back as the engine's own objects; edited ones are rebuilt without the engine's handle. */
export function applyJevCut(messages, cut) {
    const safe = safeJevCut(messages, cut);
    const dropped = new Set(safe.dropped);
    const truncated = safe.truncated;
    const out = [];
    for (const message of messages) {
        const toolUses = message.toolUses
            .filter((use) => !dropped.has(use.tool_use_id))
            .map((use) => {
            if (!(use.tool_use_id in truncated))
                return use;
            const { result: _result, ...rest } = use;
            return { ...rest, text: truncated[use.tool_use_id] };
        });
        const toolResults = (message.toolResults ?? [])
            .filter((result) => !dropped.has(result.tool_use_id))
            .map((result) => {
            if (!(result.tool_use_id in truncated))
                return result;
            const { result: _result, ...rest } = result;
            return { ...rest, text: truncated[result.tool_use_id] };
        });
        const changed = toolUses.length !== message.toolUses.length || toolResults.length !== (message.toolResults?.length ?? 0) ||
            toolUses.some((use, i) => use !== message.toolUses[i]) || toolResults.some((result, i) => result !== message.toolResults?.[i]);
        if (!changed) {
            out.push(message);
            continue;
        }
        const unknownMessageKeys = Object.keys(message).filter((key) => !['role', 'text', 'toolUses', 'toolResults', 'handle'].includes(key));
        if (!message.text.trim() && !toolUses.length && !toolResults.length) {
            if (unknownMessageKeys.length)
                out.push(message);
            continue;
        }
        const { handle: _handle, toolUses: _oldUses, toolResults: _oldResults, ...rest } = message;
        out.push({ ...rest, toolUses, ...(toolResults.length ? { toolResults } : {}) });
    }
    return out;
}
