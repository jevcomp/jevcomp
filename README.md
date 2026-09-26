# jevcomp

When a conversation gets long, Codex and Claude Code **compact** it: they replace the old history with a summary written by the model. Exact details get lost that way (an error message, a file already read, a test result), and writing the summary costs a large request.

jevcomp uses **Jev**, a small, fast AI model that only answers yes/no questions, to decide which old command outputs still matter:

- **Codex:** Codex still writes its summary. Right after, jevcomp adds back the useful details the summary lost.
- **Claude Code:** there is no summary. Jev removes or shortens old command outputs and the rest of the conversation stays word for word, which also skips the summary request.

Your own messages are never removed. If anything fails, the agent compacts the way it normally does. Each compaction makes a few small Jev requests, billed to your OpenRouter or TypeSafe key.

## Before you start

- **Node.js 20 or newer** ([nodejs.org](https://nodejs.org)).
- **Git**, used to download the plugin.
- An **API key** from [OpenRouter](https://openrouter.ai/keys) or TypeSafe.

Codex and Claude Code can both use jevcomp on the same computer. They share the key, the settings, the history and the dashboard.

## Codex

### Install

```bash
npm install -g --install-links github:jevcomp/jevcomp
jevcomp install openrouter codex
```

Use `typesafe` if your key is from TypeSafe. Then start Codex with `jevcomp codex` instead of `codex` (see below); on the first start, type `/hooks` and approve the four jevcomp hooks.

### Check

Run `jevcomp doctor`. It is working when Codex shows `jevcomp dashboard: http://127.0.0.1:43127/` as a session starts.

### Uninstall

| Installed with | Run | What it removes |
| --- | --- | --- |
| Plugin (before 0.7.3) | Ask Codex `Uninstall jevcomp` | The plugin and its marketplace; stops the dashboard unless Claude Code still uses it |
| Plugin (before 0.7.3), from a terminal | `codex plugin remove jevcomp@jevcomp` then `codex plugin marketplace remove jevcomp` | The plugin and its marketplace; the dashboard stops when you restart the computer |
| npm | `jevcomp uninstall codex` | The four hooks; stops the dashboard unless Claude Code still uses it |

## Real savings in Codex: `jevcomp codex`

With the npm command installed, start Codex from a terminal with `jevcomp codex [args]`. This runs Codex through jevcomp's local proxy. When Jev returns a usable summary that meets the minimum reduction setting, the proxy answers Codex's compaction request locally instead of sending that request to OpenAI. If Jev errors or its result is unusable or below the minimum reduction, the original request is forwarded to Codex's real server.

Only sessions started with `jevcomp codex` save tokens. Starting Codex with plain `codex` still runs the jevcomp hooks, which save nothing. In the dashboard, check the recent runs for a Codex entry; a compaction answered locally by Jev shows as completed. The dashboard records the run but does not estimate OpenAI billing-token savings.

## Antigravity (experimental)

`jevcomp agy [args]` currently sends Antigravity traffic through a local intermediary and forwards it. Set `JEVCOMP_CAPTURE=1` to save captured generation requests. It does not compact requests or provide token savings yet.

Install its local certificate with `jevcomp install agy`. OpenSSL is required; on Windows, approve the certificate warning once by clicking **Yes**. Install OpenSSL with `winget install ShiningLight.OpenSSL.Light` if needed. Remove the certificate with `jevcomp uninstall agy`.

## Claude Code

### Install

Pick one way.

**Plugin.** In a terminal:

```bash
claude plugin marketplace add jevcomp/jevcomp
claude plugin install jevcomp@jevcomp
```

**npm (recommended).** Also gives you the `jevcomp` command, needed for `jevcomp codex`, the only way that saves tokens:

```bash
npm install -g --install-links github:jevcomp/jevcomp
jevcomp install openrouter claude
```

Open Claude Code. The first time, jevcomp asks you to restart it once; after that it is on.

The key comes from the one saved by `jevcomp install` or for Codex, or from `OPENROUTER_API_KEY` / `TYPESAFE_API_KEY`. If you have none of these, run `/plugin configure jevcomp@jevcomp` in Claude Code and enter it there.

### Check

Ask Claude Code `Check jevcomp` (npm: `jevcomp doctor`). It is working when Claude Code shows `jevcomp dashboard: http://127.0.0.1:43127/` as a session starts.

### Uninstall

| Installed with | Run | What it removes |
| --- | --- | --- |
| Plugin | `claude plugin uninstall jevcomp@jevcomp` then `claude plugin marketplace remove jevcomp` | The plugin and its marketplace; the dashboard stops when you restart the computer |
| npm | `jevcomp uninstall claude` | The plugin and its marketplace; stops the dashboard unless Codex still uses it |

## Both with npm

```bash
npm install -g --install-links github:jevcomp/jevcomp
jevcomp install
```

`install` asks where to install (answer both), the provider and the key. `jevcomp uninstall` removes jevcomp from both and stops the dashboard.

## Remove everything

1. Uninstall from each agent as shown above, or run `jevcomp uninstall` if you used npm.
2. With npm, remove the command: `npm uninstall -g jevcomp`.
3. Delete your key and settings, `~/.config/jevcomp`, and your history, `~/.jevcomp`.
4. Claude Code only: remove the `"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"` line that jevcomp added under `env` in `~/.claude/settings.json`, unless another plugin needs it.

## Dashboard

Open **http://127.0.0.1:43127/**. It starts by itself when a Codex or Claude Code session starts and keeps running until you restart the computer.

- Forgot the address? Ask the agent `Where is the jevcomp dashboard?` (npm: `jevcomp doctor`).
- Restart it: `jevcomp dashboard`, or ask the agent to restart the jevcomp dashboard.
- Another port: set `JEVCOMP_DASHBOARD_PORT`, for example `43200`.

It shows only what jevcomp can measure: characters before and after each compaction, what was sent back, each Keep / Shorten / Remove decision with its risk, Jev requests and tokens, and runs that were skipped or failed. It does not estimate billing-token savings.

## Settings

Run `jevcomp settings`, use the **Configurações** page of the dashboard, or ask the agent to change a jevcomp setting. The defaults suit most people.

| Setting | Default | Meaning |
| --- | ---: | --- |
| `restore-mode` | `minimal` | Codex only. How much is added back: `minimal` (only the list of what Jev kept and where it is saved), `balanced` (the list plus an excerpt), `preserve` (all selected text). |
| `restore-max-chars` | `60000` | Codex only. Most characters added back after a compaction; `0` removes the limit. |
| `pin-recent-messages` | `6` | Newest messages Jev never touches. |
| `loss-threshold` | `0.5` | Jev removes or shortens an output only when its risk of losing something still needed is below this. Higher cuts more. |
| `min-reduction-ratio` | `0.15` | jevcomp acts only when it cuts at least this share of the text. |

Settings are saved in `~/.config/jevcomp/settings.json`. The variables `JEVCOMP_RESTORE_MODE`, `JEVCOMP_RESTORE_MAX_CHARS`, `JEVCOMP_PIN_RECENT_MESSAGES`, `JEVCOMP_LOSS_THRESHOLD` and `JEVCOMP_MIN_REDUCTION_RATIO` override them.

### Advanced options

Rarely needed; set them as environment variables.

| Option | Default | What it controls |
| --- | ---: | --- |
| `JEVCOMP_CONCURRENCY` | `4` | Jev requests at the same time. |
| `JEVCOMP_INDEX_MAX_CHARS` | `12000` | Size of the list used by `balanced` and `minimal`. |
| `JEVCOMP_MAX_STATE_TOKENS` | `24000` | Size of the conversation copy shown to Jev. |
| `JEVCOMP_MAX_REQUEST_TOKENS` | `30000` | Size of one Jev request. |
| `JEVCOMP_TRUNCATE_HEAD_CHARS` | `300` | Characters kept when an output is shortened. |
| `JEVCOMP_TIMEOUT_MS` | `20000` | Time limit for one Jev request. |
| `JEVCOMP_RETRIES` | `1` | Retries after a network failure. |
| `JEVCOMP_RESTORE_TTL_MS` | `86400000` | Codex only. How long a compaction waits to add its details back. |
| `JEVCOMP_STATE_MAX_AGE_MS` | `172800000` | Age at which leftover session files are deleted. |
| `JEVCOMP_GOAL` | automatic | Task description given to Jev instead of your recent messages. |
| `JEVCOMP_DATA_DIR` | `~/.jevcomp` | Where history and session files go. |

`JEV_MODEL`, `JEV_BASE_URL`, `OPENROUTER_JEV_MODEL`, `OPENROUTER_JEV_URL` and `OPENROUTER_HTTP_REFERER` change the Jev endpoint, for development.

### API key

`jevcomp install` (or `Configure jevcomp with ...` in Codex) saves the provider and key in `~/.config/jevcomp`; run it again to change them. `OPENROUTER_API_KEY` or `TYPESAFE_API_KEY` in the environment take precedence, with `JEVCOMP_PROVIDER` to pick one. A key can also come from a file: `OPENROUTER_API_KEY_FILE`, `TYPESAFE_API_KEY_FILE` or `JEVCOMP_KEY_FILE`.

## How it works

For each finished command, Jev answers two questions: would removing the command and its output lose something still needed, and would shortening the output. The answer becomes **Keep**, **Shorten** (the first characters plus a note) or **Remove** (the command can be run again). Your messages and Codex's instructions are never removed. Common secret patterns are hidden before anything goes to Jev, but not every possible secret can be recognised.

**Codex** does not let a hook replace its summary, so jevcomp works around it:

1. Before compaction (`PreCompact`), Jev picks what is worth keeping.
2. Codex compacts normally, and `PostCompact` confirms it.
3. When the session resumes (`SessionStart`, or the next prompt as a fallback), jevcomp adds back only the selected text that is not already in the new history word for word.

**Claude Code** lets a plugin replace the compaction itself (an early-access feature called function hooks), so there jevcomp hands back the conversation with Jev's cuts instead of a summary.

jevcomp does not judge content it cannot read (images, audio, encrypted agent messages): then the agent compacts normally. In Codex, the experimental token-budget reset also goes through jevcomp; turn jevcomp off for that if you want a completely clean context.

To preview what Jev would keep from a Codex rollout without changing anything: `jevcomp compact rollout.jsonl --context retained.txt --json retained.json`.

## Data

Everything is in `~/.jevcomp` (or `JEVCOMP_DATA_DIR`): `history.jsonl` for the dashboard, and per-session files that are deleted after two days. History from versions before 0.7.0, in `~/.codex/jevcomp` and the Codex plugin data folder, is still read. An npm install for Codex also keeps a copy of the program in `~/.codex/jevcomp/runtime` (or `JEVCOMP_RUNTIME_DIR`).

## Development

```bash
npm run check
```

No third-party runtime dependencies. `dist/` is committed so the plugins run without a build. Tests use a fake Jev and make no paid requests.

## Credits

Independent implementation informed by these MIT-licensed projects:

- `IAmUnbounded/save-token-jev-clean`
- `leonaaardob/fast-dev-compaction`
- `tamaratran/fast-jev-compaction`
- `fatelei/jevcomp` (post-compaction membership check)

`AUDIT.md` has the detailed comparison and compatibility notes.
