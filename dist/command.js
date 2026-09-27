import { execFileSync, spawn } from 'node:child_process';
// npm installs codex/claude on Windows as .cmd shims, which Node only runs through a shell.
function windowsPath(name) {
    if (process.platform !== 'win32')
        return undefined;
    try {
        return execFileSync('where.exe', [name], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })
            .split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    }
    catch {
        return undefined;
    }
}
const isShim = (path) => !!path && /\.(cmd|bat)$/i.test(path);
const quote = (arg) => /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
export function commandExists(name) {
    if (process.platform === 'win32')
        return !!windowsPath(name);
    try {
        execFileSync(name, ['--version'], { stdio: 'ignore', timeout: 20_000 });
        return true;
    }
    catch {
        return false;
    }
}
export function runSync(name, args, options = {}) {
    const path = windowsPath(name);
    if (isShim(path))
        return String(execFileSync([quote(path), ...args.map(quote)].join(' '), { ...options, shell: true }) ?? '');
    return String(execFileSync(name, [...args], options) ?? '');
}
export function launch(name, args, options, spawnFn = spawn) {
    const path = spawnFn === spawn ? windowsPath(name) : undefined;
    if (isShim(path))
        return spawnFn([quote(path), ...args.map(quote)].join(' '), [], { ...options, shell: true });
    return spawnFn(name, [...args], options);
}
