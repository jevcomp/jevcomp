import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_HOOK_TAG } from './legacy.js';
const TAGS = ['--jevcomp', LEGACY_HOOK_TAG];
function errorCode(error) {
    return error && typeof error === 'object' && 'code' in error ? String(error.code ?? '') : undefined;
}
async function loadHookConfig(path) {
    let text;
    try {
        text = await readFile(path, 'utf8');
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return { config: {}, existed: false };
        throw error;
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        throw new Error(`Cannot update ${path}: existing hooks file is invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error(`Cannot update ${path}: existing hooks file must contain a JSON object`);
    return { config: parsed, existed: true };
}
function oursHook(hook) {
    return (TAGS.some((tag) => typeof hook.command === 'string' && hook.command.includes(tag)) ||
        TAGS.some((tag) => typeof hook.commandWindows === 'string' && hook.commandWindows.includes(tag)));
}
function ours(entry) { return entry.hooks.some(oursHook); }
function withoutOurs(entry) {
    const hooks = entry.hooks.filter((hook) => !oursHook(hook));
    return hooks.length ? { ...entry, hooks } : undefined;
}
function codexHome(env) { return env.CODEX_HOME ?? join(homedir(), '.codex'); }
export function runtimeDir(env = process.env) {
    return env.JEVCOMP_RUNTIME_DIR ?? join(codexHome(env), 'jevcomp', 'runtime');
}
function legacyCodexPluginSection(header) {
    const value = header.trim();
    if (value === 'plugins."jevcomp@jevcomp"' || value === "plugins.'jevcomp@jevcomp'")
        return true;
    return (value.startsWith('hooks.state."jevcomp@jevcomp:hooks/codex.json:') && value.endsWith('"'))
        || (value.startsWith("hooks.state.'jevcomp@jevcomp:hooks/codex.json:") && value.endsWith("'"));
}
export async function removeLegacyCodexPluginConfig(env = process.env) {
    const path = env.CODEX_CONFIG_FILE ?? join(codexHome(env), 'config.toml');
    let text;
    try {
        text = await readFile(path, 'utf8');
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return path;
        throw error;
    }
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const hadFinalNewline = /\r?\n$/.test(text);
    const kept = [];
    let removing = false;
    for (const line of text.split(/\r?\n/)) {
        const section = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
        if (section)
            removing = legacyCodexPluginSection(section[1]);
        if (!removing)
            kept.push(line);
    }
    let next = kept.join(eol);
    if (hadFinalNewline && !next.endsWith(eol))
        next += eol;
    if (next === text)
        return path;
    await copyFile(path, `${path}.bak.${Date.now()}`);
    await writeFile(path, next, { mode: 0o600 });
    return path;
}
export async function removeLegacyHooks(env = process.env) {
    const path = env.CODEX_HOOKS_FILE ?? join(codexHome(env), 'hooks.json');
    let loaded;
    try {
        loaded = await loadHookConfig(path);
    }
    catch (error) {
        throw error;
    }
    if (!loaded.existed)
        return path;
    const { config } = loaded;
    const before = JSON.stringify(config);
    if (config.hooks)
        for (const key of Object.keys(config.hooks))
            config.hooks[key] = (config.hooks[key] ?? []).map(withoutOurs).filter((entry) => entry !== undefined);
    if (JSON.stringify(config) === before)
        return path;
    await copyFile(path, `${path}.bak.${Date.now()}`);
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return path;
}
