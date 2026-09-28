# jevcomp

Long coding sessions accumulate tool output that gets sent back to the model. Codex and Claude Code eventually compact that history; Antigravity sends a growing Gemini-style `contents` history. Either way, stale tool evidence consumes context, while model-written summaries can lose exact details such as an error message, a file already read, or a test result.

jevcomp uses **Jev**, a small, fast AI model that only answers yes/no questions, to decide which old command outputs still matter:

- **Codex:** started with `jevcomp codex`, the compaction request never reaches OpenAI: jevcomp answers it with what Jev kept.
- **Claude Code:** the function hook remains the compaction authority. `jevcomp claude` also routes Anthropic-format model traffic through a local gateway for usage/cache metering without changing request or response bytes.
- **Antigravity (experimental):** `jevcomp agy` uses Jev to shorten old paired tool results before generation requests while preserving Gemini tool calls, signatures and unknown payload fields.

Your own messages are never removed. If anything fails, the original agent request passes through or native compaction runs normally. Jev is called only for eligible old tool evidence, billed to your OpenRouter or TypeSafe key.

## Instalação

Primeiro, instale o jevcomp:

```powershell
npm install -g --install-links github:jevcomp/jevcomp
```

### Instalar em todos os agentes

```powershell
# OpenRouter
jevcomp install openrouter all

# TypeSafe
jevcomp install typesafe all
```

Isso configura **Codex, Claude Code e Antigravity**.

### Instalar somente no Codex, Claude Code ou Antigravity

```powershell
# Codex
jevcomp install openrouter codex
jevcomp install typesafe codex

# Claude Code
jevcomp install openrouter claude
jevcomp install typesafe claude

# Antigravity
jevcomp install openrouter agy
jevcomp install typesafe agy
```

Escolha o comando correspondente ao **provider** e ao **agente** que você usa.

## Antigravity: certificado

Se instalar para o **Antigravity**, o Windows pedirá permissão para instalar um certificado local do jevcomp.

**Aceite a instalação do certificado.**

## Verificar a instalação

```powershell
jevcomp doctor
```

Se tudo estiver correto, você verá algo parecido com:

```text
OK  API key (openrouter) // ou OK  API key (typesafe)
OK  Codex: connected
OK  Claude Code: connected
OK  Antigravity: connected
OK  Node v26.x.x

Dashboard: http://127.0.0.1:43127/
```

## Como usar

```powershell
# Codex
jevcomp codex

# Claude Code
jevcomp claude

# Antigravity
jevcomp agy
```

## Dashboard

```text
http://127.0.0.1:43127/
```

## Resumo rápido

```powershell
# 1. Instalar
npm install -g --install-links github:jevcomp/jevcomp

# 2. Configurar tudo
jevcomp install openrouter all
# ou
jevcomp install typesafe all

# 3. Verificar
jevcomp doctor

# 4. Usar
jevcomp codex
jevcomp claude
jevcomp agy
```

Depois de instalar, use `jevcomp` antes do nome do agente.

## How Codex saves tokens

`jevcomp codex [args]` runs Codex through a local proxy. When Jev returns a usable result that meets the minimum reduction setting, the proxy answers Codex's compaction request itself instead of sending it to OpenAI. If Jev fails, or its result is too big or cuts too little, the request goes to OpenAI as usual. In the dashboard, a compaction answered by Jev shows as completed.

### Claude Code only: as a plugin

Claude Code can also get jevcomp as a plugin, without npm:

```powershell
claude plugin marketplace add jevcomp/jevcomp
claude plugin install jevcomp@jevcomp
```

It saves the same as the npm install. The key comes from one saved by `jevcomp install`, from `OPENROUTER_API_KEY` / `TYPESAFE_API_KEY`, or from `/plugin configure jevcomp@jevcomp` in Claude Code.

## Uninstall

| Run | What it removes |
| --- | --- |
| `jevcomp uninstall` | jevcomp from every agent, and stops the dashboard |
| `jevcomp uninstall codex` / `claude` / `agy` | Only from that agent (`agy` also removes the certificate); the dashboard stays while another agent uses it |
| `claude plugin uninstall jevcomp@jevcomp` then `claude plugin marketplace remove jevcomp` | The Claude Code plugin |

## Remove everything

1. Run `jevcomp uninstall` (and remove the Claude Code plugin, if you used it).
2. Remove the command: `npm uninstall -g jevcomp`.
3. Delete your key and settings, `~/.config/jevcomp`, and your history, `~/.jevcomp`.
4. Claude Code only: remove the `"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"` line that jevcomp added under `env` in `~/.claude/settings.json`, unless another plugin needs it.

## Dashboard

Open **http://127.0.0.1:43127/**. It starts by itself when a Codex or Claude Code session starts and keeps running until you restart the computer.

- Forgot the address? Ask the agent `Where is the jevcomp dashboard?` (or run `jevcomp doctor`).
- Restart it: `jevcomp dashboard`, or ask the agent to restart the jevcomp dashboard.
- Another port: set `JEVCOMP_DASHBOARD_PORT`, for example `43200`.

It shows only what jevcomp can measure: characters before and after each compaction, what was sent back, each Keep / Shorten / Remove decision with its risk, Jev requests and tokens, and runs that were skipped or failed. It does not estimate billing-token savings.

## Settings

Run `jevcomp settings`, use the **Configurações** page of the dashboard, or ask the agent to change a jevcomp setting. Each program has its own settings. The defaults suit most people.

| Setting | Default | Meaning |
| --- | ---: | --- |
| `pin-recent-messages` | `6` | Newest messages Jev never touches. |
| `loss-threshold` | `0.5` | Jev removes or shortens an output only when its risk of losing something still needed is below this. Higher cuts more. |
| `min-reduction-ratio` | `0.15` | jevcomp acts only when it cuts at least this share of the text. |

Settings are saved in `~/.config/jevcomp/settings.json`. The variables `JEVCOMP_PIN_RECENT_MESSAGES`, `JEVCOMP_LOSS_THRESHOLD` and `JEVCOMP_MIN_REDUCTION_RATIO` override them.

### Advanced options

Rarely needed; set them as environment variables.

| Option | Default | What it controls |
| --- | ---: | --- |
| `JEVCOMP_CONCURRENCY` | `4` | Jev requests at the same time. |
| `JEVCOMP_MAX_STATE_TOKENS` | `24000` | Size of the conversation copy shown to Jev. |
| `JEVCOMP_MAX_REQUEST_TOKENS` | `30000` | Size of one Jev request. |
| `JEVCOMP_TRUNCATE_HEAD_CHARS` | `300` | Leading characters kept when an output is shortened. |
| `JEVCOMP_TRUNCATE_TAIL_CHARS` | `100` | Trailing characters kept when an output is shortened. |
| `JEVCOMP_AGY_MIN_ELIGIBLE_CHARS` | `2000` | New unjudged Antigravity tool-result characters required before another Jev decision batch. |
| `JEVCOMP_TIMEOUT_MS` | `20000` | Time limit for one Jev request. |
| `JEVCOMP_RETRIES` | `1` | Retries after a network failure. |
| `JEVCOMP_GOAL` | automatic | Task description given to Jev instead of your recent messages. |
| `JEVCOMP_DATA_DIR` | `~/.jevcomp` | Where history and session files go. |

`JEV_MODEL`, `JEV_BASE_URL`, `OPENROUTER_JEV_MODEL`, `OPENROUTER_JEV_URL` and `OPENROUTER_HTTP_REFERER` change the Jev endpoint, for development.

### API key

`jevcomp install` (or `Configure jevcomp with ...` in Codex) saves the provider and key in `~/.config/jevcomp`; run it again to change them. `OPENROUTER_API_KEY` or `TYPESAFE_API_KEY` in the environment take precedence, with `JEVCOMP_PROVIDER` to pick one. A key can also come from a file: `OPENROUTER_API_KEY_FILE`, `TYPESAFE_API_KEY_FILE` or `JEVCOMP_KEY_FILE`.

## How it works

For each finished command, Jev answers two questions: would removing the command and its output lose something still needed, and would shortening the output. The answer becomes **Keep**, **Shorten** (the first characters plus a note) or **Remove** (the command can be run again). Your messages and Codex's instructions are never removed. Common secret patterns are hidden before anything goes to Jev, but not every possible secret can be recognised.

**Codex** runs through `jevcomp codex`. Its local proxy answers compaction requests with Jev's cuts when they meet the configured reduction threshold; otherwise the request goes to OpenAI as usual.

**Claude Code** lets a plugin replace the compaction itself (an early-access feature called function hooks), so there jevcomp hands back the conversation with Jev's cuts instead of a summary.

jevcomp does not judge content it cannot read (images, audio, encrypted agent messages): then the agent compacts normally. In Codex, the experimental token-budget reset also goes through jevcomp; turn jevcomp off for that if you want a completely clean context.

To preview what Jev would keep from a Codex rollout without changing anything: `jevcomp compact rollout.jsonl --context retained.txt --json retained.json`.

## Data

Everything is in `~/.jevcomp` (or `JEVCOMP_DATA_DIR`): `history.jsonl` for the dashboard. History from versions before 0.7.0, in `~/.codex/jevcomp` and the old Codex plugin data folder, is still read.

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
