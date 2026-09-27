import { resetUserSettings, setUserSetting, settingOverride, userSettings, type SettingName, type SettingsAgent, type UserSettings } from './settings.js';

type Env = Record<string, string | undefined>;
interface Choice { value: string; label: string }
interface Item { name: SettingName; title: string; help: string; choices: Choice[]; current: (settings: UserSettings) => string }

const percent = (n: number) => `${Math.round(n * 100)}%`;

export const SETTINGS_ITEMS: Item[] = [
  {
    name: 'pin-recent-messages',
    title: 'Recent messages never cut',
    help: 'The newest messages always stay whole. Higher is safer; lower lets jevcomp cut more.',
    choices: [2, 4, 6, 8, 12].map((n) => ({ value: String(n), label: String(n) })),
    current: (settings) => String(settings.pinRecentMessages),
  },
  {
    name: 'loss-threshold',
    title: 'How much to cut',
    help: 'Jev estimates the risk of cutting something Codex still needs. Little: cuts only low-risk output. A lot: cuts more.',
    choices: [
      { value: '0.3', label: 'Little' },
      { value: '0.5', label: 'Normal' },
      { value: '0.7', label: 'A lot' },
    ],
    current: (settings) => String(settings.lossThreshold),
  },
  {
    name: 'min-reduction-ratio',
    title: 'Only act if it cuts at least',
    help: 'If cutting would shrink the text by less than this, jevcomp leaves that compaction alone.',
    choices: [0.05, 0.1, 0.15, 0.25, 0.4].map((n) => ({ value: String(n), label: percent(n) })),
    current: (settings) => String(settings.minReductionRatio),
  },
];

const RESET_ROW = 'Reset all to defaults';

function choicesWithCurrent(item: Item, settings: UserSettings): Choice[] {
  const value = item.current(settings);
  if (item.choices.some((choice) => Number(choice.value) === Number(value) || choice.value === value)) return item.choices;
  return [...item.choices, { value, label: `${value} (custom)` }];
}

function indexOfCurrent(item: Item, settings: UserSettings): number {
  const value = item.current(settings);
  return choicesWithCurrent(item, settings).findIndex((choice) => choice.value === value || Number(choice.value) === Number(value));
}

export function describeSettings(env: Env, agent: SettingsAgent): Array<{ title: string; value: string; lockedBy?: string }> {
  const settings = userSettings(env, agent);
  return SETTINGS_ITEMS.map((item) => ({
    title: item.title,
    value: choicesWithCurrent(item, settings)[indexOfCurrent(item, settings)]?.label ?? item.current(settings),
    lockedBy: settingOverride(item.name, env),
  }));
}

/** Moves one setting to its previous or next choice and saves it. */
export async function stepSetting(name: SettingName, direction: 1 | -1, env: Env, agent: SettingsAgent): Promise<void> {
  const item = SETTINGS_ITEMS.find((candidate) => candidate.name === name)!;
  const settings = userSettings(env, agent);
  const choices = choicesWithCurrent(item, settings);
  const next = choices[(indexOfCurrent(item, settings) + direction + choices.length) % choices.length]!;
  await setUserSetting(name, next.value, env, agent);
}

function render(selected: number, env: Env, agent: SettingsAgent, notice: string): string[] {
  const rows = describeSettings(env, agent);
  const width = Math.max(...rows.map((row) => row.title.length)) + 4;
  const lines = ['jevcomp settings (changes are saved right away)', ''];
  rows.forEach((row, index) => {
    const marker = index === selected ? '> ' : '  ';
    const value = row.lockedBy ? `${row.value} (set by ${row.lockedBy})` : row.value;
    lines.push(`${marker}${row.title.padEnd(width)}${value}`);
  });
  lines.push(`${selected === rows.length ? '> ' : '  '}${RESET_ROW}`);
  lines.push('');
  const help = selected < SETTINGS_ITEMS.length ? SETTINGS_ITEMS[selected]!.help : 'Puts every setting back to its default value.';
  lines.push(`  ${help}`);
  lines.push('');
  lines.push(notice || '  Up/Down: choose   Left/Right or Enter: change   Esc: done');
  return lines;
}

interface Terminal {
  input: { on(event: 'data', listener: (chunk: any) => void): unknown; off(event: 'data', listener: (chunk: any) => void): unknown; setRawMode?(mode: boolean): unknown; resume(): unknown; pause(): unknown };
  output: { write(text: string): unknown; columns?: number };
}

/** Runs the arrow-key menu until Esc, q or Ctrl+C. */
export async function runSettingsMenu(terminal: Terminal, env: Env, agent: SettingsAgent): Promise<void> {
  let selected = 0;
  let notice = '';
  let drawn = 0;
  const draw = () => {
    const lines = render(selected, env, agent, notice);
    const reset = drawn ? `\x1b[${drawn}F\x1b[J` : '';
    terminal.output.write(`${reset}${lines.join('\n')}\n`);
    drawn = lines.length;
  };
  terminal.input.setRawMode?.(true);
  terminal.input.resume();
  draw();
  await new Promise<void>((resolve) => {
    let busy = Promise.resolve();
    const finish = () => { terminal.input.off('data', onData); terminal.input.setRawMode?.(false); terminal.input.pause(); resolve(); };
    const change = async (direction: 1 | -1) => {
      notice = '';
      if (selected === SETTINGS_ITEMS.length) {
        await resetUserSettings(env, agent);
        notice = '  All settings are back to their defaults.';
        return;
      }
      const item = SETTINGS_ITEMS[selected]!;
      const lockedBy = settingOverride(item.name, env);
      if (lockedBy) { notice = `  ${lockedBy} is set in your environment, so it decides this value.`; return; }
      await stepSetting(item.name, direction, env, agent);
    };
    const onData = (chunk: any) => {
      busy = busy.then(async () => {
        const key = String(chunk);
        if (key === '\x1b' || key === 'q' || key === '\x03') { finish(); return; }
        if (key === '\x1b[A') selected = (selected + SETTINGS_ITEMS.length) % (SETTINGS_ITEMS.length + 1);
        else if (key === '\x1b[B') selected = (selected + 1) % (SETTINGS_ITEMS.length + 1);
        else if (key === '\x1b[C' || key === '\r' || key === '\n' || key === ' ') await change(1);
        else if (key === '\x1b[D') await change(-1);
        else return;
        draw();
      }).catch((error) => { notice = `  ${error instanceof Error ? error.message : String(error)}`; draw(); });
    };
    terminal.input.on('data', onData);
  });
}
