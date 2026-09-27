#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compactForClaude } from './claude-compact.js';
import { runCodex } from './codex-proxy.js';
import { commandExists, runSync } from './command.js';
import { installAgyCa, runAgy, uninstallAgyCa } from './agy-proxy.js';
import { compactMessages, reductionRatio } from './compact.js';
import { startDashboard } from './dashboard.js';
import { dashboardInstancePath, dashboardPort, ensureDashboard, restartDashboard, runningDashboard, stopDashboard } from './dashboard-service.js';
import { enableFunctionHooks, handleHook } from './hooks.js';
import { resetUserSettings, setUserSetting, userSettings, type SettingName, type SettingsAgent } from './settings.js';
import { describeSettings, runSettingsMenu, SETTINGS_ITEMS } from './settings-menu.js';
import { removeLegacyHooks, runtimeDir } from './install.js';
import { adoptLegacyEnvironment, migrateLegacyConfig } from './legacy.js';
import { configDir, hasSavedProviderKey, providerConfig, resolveApiKey, resolveProvider, saveProviderConfiguration, type JevProvider } from './provider.js';
import { renderMessages } from './render.js';
import { loadCodexRollout } from './rollout.js';
import { dataDir } from './store.js';
import { auditCommand } from './audit-cli.js';

async function stdin(): Promise<string> { let s = ''; for await (const chunk of process.stdin) s += chunk; return s; }
function flag(args: string[], name: string): string | undefined { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
function fmt(n: number): string { return Number(n || 0).toLocaleString(); }
function chars(n: number): string { return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M chars` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k chars` : `${fmt(n)} chars`; }

function help(): void {
  const command = 'jevcomp';
  console.log(`jevcomp

  ${command} install      Connect jevcomp to Codex, Claude Code or Antigravity
  ${' '.repeat(command.length)}              and enter your key (run it again to change them)
  ${' '.repeat(command.length)}              Skip the questions: install [openrouter|typesafe] [codex|claude|agy|all]
  ${command} settings [codex|claude|agy] [name value|reset]  Change settings (default: codex)
  ${command} doctor       Check that everything works
  ${command} dashboard    Restart the dashboard
  ${command} uninstall    Remove jevcomp from Codex, Claude Code or Antigravity
  ${' '.repeat(command.length)}              Only one of them: uninstall codex, uninstall claude, uninstall agy
  ${command} codex [args]  Run Codex through the local proxy; compaction is answered by Jev
  ${command} agy [args]   Run Antigravity through the local proxy
  ${command} audit        Configure and inspect local decision evidence

Dashboard: ${dashboardAddress()} (opens with each Codex or Claude Code session)`);
}

type Agent = 'codex' | 'claude' | 'agy';
const AGENT_NAMES: Record<Agent, string> = { codex: 'Codex', claude: 'Claude Code', agy: 'Antigravity' };

function agentArgs(args: readonly string[]): Agent[] | undefined {
  if (args.includes('all') || args.includes('both')) return ['codex', 'claude'];
  const picked = (['codex', 'claude', 'agy'] as const).filter((agent) => args.includes(agent));
  return picked.length ? picked : undefined;
}

async function chooseAgents(args: readonly string[]): Promise<Agent[]> {
  const requested = agentArgs(args);
  if (requested) return requested;
  const found = (['codex', 'claude', 'agy'] as const).filter(commandExists);
  if (!found.length) throw new Error('none of codex, claude or agy was found; install one of them first');
  const withoutCertificate = found.filter((agent) => agent !== 'agy');
  if (!interactive() || found.length === 1) {
    if (!withoutCertificate.length) throw new Error('only Antigravity was found; run `jevcomp install agy` to install its certificate');
    return withoutCertificate;
  }
  const names = found.map((agent, index) => `${index + 1}) ${AGENT_NAMES[agent]}`).join('  ');
  const answer = await ask(`Install for: ${names}  ${found.length + 1}) all  (e.g. 1,3) [${found.length + 1}]: `);
  if (!answer || answer === String(found.length + 1)) return [...found];
  const picked = answer.split(/[\s,]+/).map((choice) => found[Number(choice) - 1]);
  if (picked.some((agent) => !agent)) throw new Error(`unknown choice: ${answer}`);
  return [...new Set(picked.filter((agent): agent is Agent => !!agent))];
}

function claudePluginInstalled(): boolean {
  try {
    const plugins = JSON.parse(runSync('claude', ['plugin', 'list', '--json'], { encoding: 'utf8', timeout: 30_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }));
    return Array.isArray(plugins) && plugins.some((plugin) => plugin?.id === 'jevcomp@jevcomp');
  } catch { return false; }
}

function removeClaudePlugin(): void {
  for (const argv of [['plugin', 'uninstall', 'jevcomp@jevcomp'], ['plugin', 'marketplace', 'remove', 'jevcomp']]) {
    try { runSync('claude', argv, { stdio: 'ignore', timeout: 60_000, windowsHide: true }); } catch {}
  }
}

/** Claude Code copies the plugin into its own cache, so this package folder is only read once. */
async function installClaude(): Promise<void> {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  removeClaudePlugin();
  runSync('claude', ['plugin', 'marketplace', 'add', packageRoot], { stdio: 'inherit', windowsHide: true });
  runSync('claude', ['plugin', 'install', 'jevcomp@jevcomp'], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  console.log(await enableFunctionHooks(process.env));
}

function dashboardAddress(): string { return `http://127.0.0.1:${dashboardPort(process.env)}/`; }

async function ask(question: string): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await prompt.question(question)).trim(); } finally { prompt.close(); }
}

function interactive(): boolean { return !!process.stdin.isTTY && !!process.stdout.isTTY; }

async function chooseProvider(requested: string | undefined): Promise<Exclude<JevProvider, 'auto'>> {
  if (requested === 'openrouter' || requested === 'typesafe') return requested;
  if (requested) throw new Error('usage: jevcomp install [openrouter|typesafe]');
  const current = resolveProvider({ env: process.env });
  if (!interactive()) return current;
  const answer = await ask(`Provider: 1) OpenRouter  2) TypeSafe  [${current === 'openrouter' ? 1 : 2}]: `);
  if (!answer) return current;
  if (answer === '1' || /^openrouter$/i.test(answer)) return 'openrouter';
  if (answer === '2' || /^typesafe$/i.test(answer)) return 'typesafe';
  throw new Error(`unknown provider: ${answer}`);
}

async function secret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') return (await stdin()).trim();
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const cleanup = () => { process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); };
    const onData = (chunk: any) => {
      const text = String(chunk);
      for (const ch of text) {
        if (ch === '\u0003') { cleanup(); process.stdout.write('\n'); reject(new Error('cancelled')); return; }
        if (ch === '\r' || ch === '\n') { cleanup(); process.stdout.write('\n'); resolve(value.trim()); return; }
        if (ch === '\u007f' || ch === '\b') { if (value) { value = value.slice(0, -1); process.stdout.write('\b \b'); } continue; }
        if (ch >= ' ') { value += ch; process.stdout.write('*'); }
      }
    };
    process.stdin.on('data', onData);
  });
}

async function readiness() {
  const provider = resolveProvider({ provider: process.env.JEVCOMP_PROVIDER as JevProvider | undefined, env: process.env });
  const config = providerConfig({ provider, env: process.env });
  const marker = join(configDir(process.env), 'codex-installed');
  const codexInstalled = existsSync(marker);
  const settings = userSettings(process.env, 'codex');
  return {
    node: process.version ?? 'unknown',
    provider,
    apiKeyConfigured: !!resolveApiKey(provider, { env: process.env }),
    model: config.model,
    baseUrl: config.baseUrl,
    codexInstalled,
    dataDir: dataDir(process.env),
    dashboardUrl: (await runningDashboard(dashboardPort(process.env), process.env))?.url ?? null,
    settings,
  };
}


function printSettings(agent: SettingsAgent): void {
  const rows = describeSettings(process.env, agent);
  const width = Math.max(...rows.map((row) => row.title.length)) + 4;
  for (const row of rows) console.log(`${row.title.padEnd(width)}${row.value}${row.lockedBy ? ` (set by ${row.lockedBy})` : ''}`);
}

async function saveKey(provider: Exclude<JevProvider, 'auto'>): Promise<void> {
  const label = provider === 'typesafe' ? 'TypeSafe' : 'OpenRouter';
  if (hasSavedProviderKey(provider, process.env)) { console.log(`Using the saved ${label} key.`); return; }
  if (resolveApiKey(provider, { env: process.env })) { console.log(`Using the ${label} key from your system variables.`); return; }
  const key = await secret(`${label} API key: `);
  if (!key) throw new Error(`${label} API key is required`);
  await saveProviderConfiguration(provider, key, process.env);
  console.log(`${label} key saved.`);
}

async function install(args: readonly string[]): Promise<void> {
  const agents = await chooseAgents(args);
  if (agents.some((agent) => agent !== 'agy')) {
    const provider = await chooseProvider(args.find((arg) => !['codex', 'claude', 'agy', 'all', 'both'].includes(arg)));
    await saveKey(provider);
  }
  if (agents.includes('claude')) await installClaude();
  if (agents.includes('codex')) {
    await removeLegacyHooks(process.env);
    await rm(runtimeDir(process.env), { recursive: true, force: true });
    await mkdir(configDir(process.env), { recursive: true, mode: 0o700 });
    await writeFile(join(configDir(process.env), 'codex-installed'), '');
    console.log('Connected to Codex. Start it with `jevcomp codex`.');
  }
  // Last, so a refused Windows certificate prompt cannot stop the other agents from installing.
  if (agents.includes('agy')) {
    try { await installAgyCa(); console.log('Connected to Antigravity. Start it with `jevcomp agy`.'); }
    catch (error) {
      process.exitCode = 1;
      console.error(`Antigravity was not installed: the certificate was not accepted (${error instanceof Error ? error.message : String(error)}). Run \`jevcomp install agy\` to try again.`);
    }
  }
  const sessions = agents.filter((agent) => agent !== 'agy').map((agent) => AGENT_NAMES[agent]).join(' or ');
  if (sessions) console.log(`Dashboard: ${dashboardAddress()} (opens with each ${sessions} session)`);
}

async function uninstall(args: readonly string[]): Promise<void> {
  if (args.includes('agy') || args.includes('all') || !args.length) await uninstallAgyCa();
  if (args.length === 1 && args[0] === 'agy') return;
  args = args.filter((arg) => arg !== 'agy');
  const agents = agentArgs(args) ?? ['codex', 'claude'];
  const claudeInstalled = claudePluginInstalled();
  const codexMarker = join(configDir(process.env), 'codex-installed');
  const codexStays = !agents.includes('codex') && existsSync(codexMarker);
  // The dashboard serves both agents, so it keeps running while one of them still uses jevcomp.
  if (!codexStays && !(claudeInstalled && !agents.includes('claude'))) await stopDashboard(dashboardPort(process.env), process.env);
  if (agents.includes('claude')) {
    if (claudeInstalled) removeClaudePlugin();
    console.log(claudeInstalled ? 'jevcomp was removed from Claude Code.' : 'jevcomp was not installed in Claude Code.');
  }
  if (!agents.includes('codex')) {
    console.log(`Kept your key and settings: ${configDir(process.env)}`);
    return;
  }
  await removeLegacyHooks();
  await rm(runtimeDir(process.env), { recursive: true, force: true });
  await rm(codexMarker, { force: true });
  console.log('jevcomp was removed from Codex.');
  console.log(`Kept your key and settings: ${configDir(process.env)}`);
  console.log(`Kept your history: ${dataDir(process.env)}`);
  console.log('Delete those folders to erase them too.');
  if (fileURLToPath(import.meta.url).includes(`node_modules${sep}jevcomp${sep}`)) console.log('To remove the jevcomp command as well: npm uninstall -g jevcomp');
}

async function main(): Promise<void> {
  adoptLegacyEnvironment(process.env);
  migrateLegacyConfig(process.env);
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return help();
  if (cmd === 'audit') return auditCommand(args, process.env);
  if (cmd === 'hook') { const out = await handleHook(JSON.parse(await stdin()), process.env, { startDashboard: true }); process.stdout.write(`${JSON.stringify(out)}\n`); return; }

  if (cmd === 'settings') {
    const agent: SettingsAgent = ['codex', 'claude', 'agy'].includes(args[0] ?? '') ? args.shift() as SettingsAgent : 'codex';
    if (args[0] === 'reset') { await resetUserSettings(process.env, agent); printSettings(agent); return; }
    if (args.length >= 2) {
      const name = args[0] as SettingName;
      if (!SETTINGS_ITEMS.some((item) => item.name === name)) throw new Error(`unknown setting: ${args[0]}`);
      await setUserSetting(name, args[1]!, process.env, agent);
      printSettings(agent);
      return;
    }
    if (!interactive()) { printSettings(agent); return; }
    await runSettingsMenu({ input: process.stdin, output: process.stdout }, process.env, agent);
    return;
  }

  if (cmd === 'install') { await install(args); return; }
  if (cmd === 'uninstall') { await uninstall(args); return; }
  if (cmd === 'codex') {
    process.exitCode = await runCodex(args, process.env, { startDashboard: () => ensureDashboard(dashboardPort(process.env), process.env) });
    return;
  }
  if (cmd === 'agy') { process.exitCode = await runAgy(args); return; }

  if (cmd === 'doctor') {
    const value = await readiness();
    if (args.includes('--json')) { console.log(JSON.stringify(value, null, 2)); return; }
    console.log(`jevcomp doctor\n`);
    console.log(`${value.apiKeyConfigured ? 'OK' : 'MISSING'}  API key (${value.provider})`);
    console.log(`${value.codexInstalled ? 'OK' : 'MISSING'}  Codex: ${value.codexInstalled ? 'installed' : 'not installed'}`);
    console.log(`OK  Node ${value.node}`);
    console.log(`    Model: ${value.model}`);
    console.log(`    Data:  ${value.dataDir}`);
    console.log(`    Dashboard: ${value.dashboardUrl ?? `${dashboardAddress()} (not running; starts with the next Codex session)`}`);
    console.log(`    Pruning: loss <= ${value.settings.lossThreshold.toFixed(2)} · pin ${fmt(value.settings.pinRecentMessages)} recent messages · require ${(value.settings.minReductionRatio * 100).toFixed(0)}% reduction`);
    if (!value.apiKeyConfigured || !value.codexInstalled) {
      console.log(`\nFix: jevcomp install`);
    }
    return;
  }

  if (cmd === 'compact') {
    if (!args[0]) throw new Error('compact requires a rollout JSONL path');
    const messages = await loadCodexRollout(args[0]);
    const result = await compactMessages(messages);
    const rendered = renderMessages(result.messages);
    const contextFile = flag(args, '--context');
    const jsonFile = flag(args, '--json');
    if (contextFile) await writeFile(contextFile, `${rendered}\n`);
    else process.stdout.write(`${rendered}\n`);
    if (jsonFile) await writeFile(jsonFile, `${JSON.stringify({ messages: result.messages, decisions: result.decisions, stats: result.stats }, null, 2)}\n`);
    console.error(JSON.stringify({ ...result.stats, reductionRatio: reductionRatio(result) }, null, 2));
    return;
  }

  if (cmd === 'claude-compact') {
    let answer: Record<string, unknown>;
    try { answer = await compactForClaude(JSON.parse(await stdin()), process.env); }
    catch (error) { answer = { apply: false, reason: error instanceof Error ? error.message : String(error) }; }
    process.stdout.write(`${JSON.stringify(answer)}
`);
    return;
  }
  if (cmd === 'dashboard') {
    const requested = flag(args, '--port') ?? args.find((x) => /^\d+$/.test(x));
    const port = requested ? Number(requested) : dashboardPort(process.env);
    if (args.includes('--background')) {
      const instanceId = process.env.JEVCOMP_DASHBOARD_INSTANCE_ID ?? randomUUID();
      process.env.JEVCOMP_DASHBOARD_INSTANCE_ID = instanceId;
      const { server, url } = await startDashboard(port);
      if (port !== 0) {
        try {
          await mkdir(dataDir(process.env), { recursive: true, mode: 0o700 });
          await writeFile(dashboardInstancePath(port), JSON.stringify({ pid: process.pid, instanceId, url }), { mode: 0o600 });
        } catch (error) {
          server.close();
          throw error;
        }
      }
      process.stdout.write(`${url}\n`);
      return;
    }
    const url = await restartDashboard(port, process.env);
    console.log(`Dashboard: ${url}`);
    return;
  }
  throw new Error(`unknown command: ${cmd}`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
