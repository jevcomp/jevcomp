---
name: jevcomp
description: Configure jevcomp with OpenRouter or TypeSafe, check plugin readiness, give the dashboard address, uninstall it, and explain compaction decisions and metrics.
---

# jevcomp

Use this skill when the user asks to set up an API key, check readiness, find the dashboard, uninstall jevcomp, or inspect compaction decisions and metrics.

## Plugin setup

Find the installed `jevcomp` entry with `codex plugin list --json` and use its `installedPath` to run `dist/cli.js`. Do not assume a global `jevcomp` command exists.

Run `node "<installedPath>/dist/cli.js" doctor --json` first. If `apiKeyConfigured` is true, keep the current provider and key. Check `/hooks` in Codex and confirm PreCompact, PostCompact, SessionStart, and UserPromptSubmit are active.

When the user asks to check jevcomp, answer in plain words: whether the key is set and for which provider, and the dashboard address. Use `dashboardUrl` from `doctor --json`; when it is empty, give `http://127.0.0.1:43127/` and say it starts with the next Codex session. You cannot see `/hooks`, so ask the user to type `/hooks` and confirm the four jevcomp hooks are active. Tell them the installation is complete when Codex shows the `jevcomp dashboard:` message as a session starts, because only the jevcomp hooks print it.

When the user asks where the dashboard is, run `doctor --json` and give `dashboardUrl`. When it is empty, run `dashboard` from the installed CLI path to start it, then give the address it prints.

When the user asks to uninstall jevcomp, run `uninstall codex` from the installed CLI path and show its output: it removes the plugin and its marketplace, stops the dashboard unless Claude Code still uses jevcomp, and lists the folders it kept. Run plain `uninstall` only when the user asks to remove jevcomp from Claude Code too.

If the key is missing or the user wants to change it, use `install openrouter` or `install typesafe` from that installed CLI path (plain `install` asks). Ask which provider only when the user has not specified one. `install` also removes older standalone jevcomp hooks. Give the exact local command and have the user enter the key in the terminal's masked prompt; never ask for the key in chat. Plugin setup keeps hook management inside Codex. Recheck `doctor --json` and `/hooks` afterward. In plugin mode, `hooksInstalled` describes only standalone user hooks; `pluginRoot` identifies the plugin package.

## Claude Code

In Claude Code the plugin folder is `~/.claude/plugins/cache/jevcomp/jevcomp/<version>`; run `dist/cli.js doctor --json` from it for the key and the dashboard address. Compaction there runs through the function hook in `hooks/claude.js`, which needs `"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"` under `env` in `~/.claude/settings.json`; the plugin adds it at the first session start, and Claude Code must then be restarted once. To uninstall, run `dist/cli.js uninstall claude` from that folder; plain `uninstall` also removes jevcomp from Codex.

## Lifecycle

- `SessionStart(startup/resume/clear)`: check for a usable API key and migrate older jevcomp hooks before the plugin runs.
- `PreCompact`: read the Codex rollout, reconstruct model-visible conversation content, score completed tool calls/results with Jev, and write retained sidecars.
- Codex runs its native compaction unchanged.
- `PostCompact`: mark the prepared sidecar ready only after compaction succeeds.
- `SessionStart(source=compact)`: compare retained evidence with the new compacted Codex history and inject only selected evidence still missing verbatim. `UserPromptSubmit` is a recovery fallback if that lifecycle delivery is missed.

Do not claim that hook mode rewrites the native Codex compaction request. It preserves selected tool evidence around native compaction.

## Useful commands

- `node "<installedPath>/dist/cli.js" install openrouter` (OpenRouter)
- `node "<installedPath>/dist/cli.js" install typesafe` (TypeSafe)
- `node "<installedPath>/dist/cli.js" doctor`
- `node "<installedPath>/dist/cli.js" uninstall codex` (keeps the key, settings and history; plain `uninstall` also removes it from Claude Code)
- `node "<installedPath>/dist/cli.js" settings`
- `node "<installedPath>/dist/cli.js" settings restore-mode balanced`
- `node "<installedPath>/dist/cli.js" dashboard` (restarts it; the plugin already starts it at `http://127.0.0.1:43127/` with each Codex session)
- `node "<installedPath>/dist/cli.js" compact <rollout.jsonl> --context retained.txt --json retained.json`
- `jevcomp codex [args]` (npm command: run Codex through Jev's local compaction proxy; dashboard entries show Codex runs answered locally)
- `jevcomp install agy` (experimental Antigravity certificate setup; requires OpenSSL and asks once on Windows)
- `jevcomp uninstall agy` (removes the Antigravity certificate)
- `jevcomp agy [args]` (experimental pass-through proxy; captures generation requests only with `JEVCOMP_CAPTURE=1`, with no token savings yet)

## Files

The data directory is `PLUGIN_DATA`, then `JEVCOMP_DATA_DIR`, then the active plugin's data directory, then `CODEX_HOME/jevcomp` (or `~/.codex/jevcomp`).
Per-session files include state, a full retained normalized context archive, and structured retained messages. History metrics are stored in `history.jsonl`.


## Restore semantics

Preferred modes are `minimal` (default), `balanced`, and `preserve`. The restore hooks set Codex `additionalContextLimit` to `0` intentionally so Codex does not apply its own generic hook-output spill on top of jevcomp's restore mode/cap. `JEVCOMP_RESTORE_MAX_CHARS` is therefore the plugin-level global cap for the selected evidence payload in all restore modes; mode-specific limits may be smaller.

People change settings with the `settings` menu in a terminal. From Codex, use `settings NAME VALUE` (names below) and show the result, which lists every setting in plain words. The user-facing controls are `restore-mode`, `restore-max-chars`, `pin-recent-messages`, `loss-threshold`, and `min-reduction-ratio`. Environment variables remain overrides for automation and compatibility.

Post-compaction dedupe is intentionally exact/conservative: message role+full text must match, and a completed tool pair is considered present only when both exact call and exact result survive. The checkpoint used for membership must be newer than the byte position recorded at `PreCompact`; otherwise restore falls back to the full preservation-first behavior.

The preferred pruning control is `loss-threshold` / `JEVCOMP_LOSS_THRESHOLD` (default `0.5`). Higher means more aggressive pruning because a higher Jev-estimated loss risk is accepted. The old `JEVCOMP_KEEP_THRESHOLD` name remains an alias.

For what happened in past compactions, read `history.jsonl` in the `dataDir` reported by `doctor --json`, or point the user to the dashboard.
