function stringify(value) {
    if (typeof value === 'string')
        return value;
    try {
        return JSON.stringify(value) ?? String(value);
    }
    catch {
        return '[unserializable]';
    }
}
export function renderMessages(messages) {
    const out = [];
    for (const message of messages) {
        if (message.text.trim())
            out.push(`[${message.role}]\n${message.text}`);
        for (const call of message.toolCalls)
            out.push(`[tool ${call.name} ${call.id}]\n${stringify(call.input)}`);
        for (const result of message.toolResults ?? [])
            out.push(`[result ${result.callId}${result.isError ? ' error' : ''}]\n${result.output}`);
    }
    return out.join('\n\n');
}
