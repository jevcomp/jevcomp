# Base-project audit

Audit date: 2026-09-22.

Compared against:

- `IAmUnbounded/save-token-jev-clean`
- `leonaaardob/fast-dev-compaction`
- current `openai/codex` main, including compaction lifecycle, rollout reconstruction, hook schema, and plugin manifest guidance.

## Important correction about PreCompact

The two base Codex implementations are not wrong for using `PreCompact`.

Their design is:

1. inspect the rollout before Codex compacts it;
2. use Jev to choose exact evidence worth preserving;
3. save that retained evidence to a sidecar;
4. allow Codex native compaction to run;
5. restore the retained evidence after successful compaction.

Current Codex command hooks give `PreCompact` control over continue/stop, not a rewritten history payload. Therefore this hook architecture is a **retention layer around native compaction**, not a replacement for the native compaction request. That distinction does not make the base projects useless; it describes what they actually implement.

`PostCompact` plus `SessionStart(source=compact)` is useful because Codex only queues the compact session-start source after it installs the replacement history. Our implementation keeps that behavior and makes the sidecar consumable only after `PostCompact` confirms success.

## Feature comparison after this audit

| Capability | save-token | fast-dev | ours 0.4 | Decision |
|---|---:|---:|---:|---|
| PreCompact selection | yes | yes | yes | kept |
| Native Codex compaction remains in control | yes | yes | yes | kept |
| PostCompact confirmation | no | yes | yes | kept from fast-dev |
| SessionStart(compact) restore | yes | yes | yes | kept |
| UserPromptSubmit recovery fallback | no | no | yes | extra safety |
| Replay `replacement_history` | incomplete | yes | yes | kept/improved |
| Modern bounded rollout tail loading | no | no | yes | Codex-aware improvement |
| Legacy compaction handling | weak | yes | yes | kept |
| Legacy rollback correctness | no | partial/full replay | fail-open | deliberate: never judge known-wrong history |
| Plaintext inter-agent communication | no | no | yes | Codex-aware improvement |
| Encrypted agent context | not handled | not handled | fail-open | deliberate |
| Image/audio message or tool-result context | opaque/generic handling varies | not handled | fail-open | Codex-aware: do not let text-only Jev judge unseen media |
| Developer/system message preservation | generic adapter yes | Codex parser user/assistant only | yes | fixed in 0.2 |
| `tool_search_output.tools` | generic adapter loses it | explicit support | yes | fixed before 0.2 |
| Staged Jev state fitting | yes | yes | yes | kept |
| Preserve recent messages | yes | yes | yes | kept |
| Conservative KEEP -> TRUNCATE -> DROP precedence | yes | yes | yes | restored in 0.2 |
| Untouched object identity | yes | yes | yes | restored in 0.2 |
| Concurrent Jev batches | bounded | unbounded Promise.all | bounded | kept from save-token |
| Provider timeout | yes | no | yes | kept |
| Retry/backoff | limited | no | yes, including Retry-After | improved |
| Real Jev usage tokens | response supports it, not central | no | yes | improved |
| Direct TypeSafe | yes | yes | yes | kept |
| OpenRouter Decisions API | no | no | yes | added |
| API-key file fallback | macOS keychain/env | yes | yes | key-file behavior kept, no platform-specific keychain dependency |
| `PLUGIN_DATA` | yes | plugin-style data | yes | fixed in 0.2 |
| Full retained normalized context file | sidecar context | yes | yes | kept |
| Structured retained messages file | no | yes | yes | restored in 0.2 |
| Stale sidecar cleanup | no | 48h | 48h | restored in 0.2 |
| Stale pending state invalidation on new PreCompact | no | no | yes | prevents an older prepared sidecar being readied by a later compaction |
| Result head/tail before large reinjection | no | yes | yes | restored in 0.2 |
| Full restore mode | effectively yes | yes, capped | yes, optional (default until 0.7.2) | `minimal` is the default since 0.7.3 |
| Index restore mode | no | no | yes, optional | token-first option |
| Per-tool decision/removal history | yes | limited | yes | restored in 0.2 |
| Dashboard | rich, auto-start | no | rich, auto-start | started at Codex session start, never from a compaction hook |
| Windows hook command | limited | yes | yes | restored in 0.2 |
| Manual compact + JSON/context outputs | generic CLI | yes | yes | restored in 0.2 |
| Skill docs | no | yes | yes | restored in 0.2 |
| Valid plugin author metadata | yes | yes | yes | fixed in 0.2 |
| Marketplace manifest | repo-specific URL | valid published URL | yes, `jevcomp/jevcomp` | real repository URL |
| Claude/OpenCode/OpenAI generic adapters | yes | no | no | intentionally out of Codex-focused runtime scope |
| Exact post-compaction membership/dedupe before restore | no | no | yes (0.5) | avoids reinjecting selected evidence already present verbatim |
| Observe/shadow mode with no context mutation | no | no | removed in 0.6.3 | added in 0.5; see the 0.6.3 entry |

## Deliberate non-copies

### Multi-host adapters

`save-token-jev-clean` is a portable library for multiple hosts. This project is deliberately Codex-first. Copying Claude/OpenCode/OpenAI adapter surfaces does not improve the Codex hook and would increase maintenance/API surface. The core Jev engine remains separable, so adapters can be added later without changing compaction semantics.

### Auto-start dashboard

`save-token` can start its dashboard from the hook path. Ours starts it at Codex session start, never from a compaction hook, so compaction does not spawn or probe an extra process. Metrics are still always recorded locally.

### Marketplace placeholder

A local package cannot honestly contain a Git marketplace URL until a real repository exists. The previous `YOUR_ORG` manifest was removed. The repository is now published as `jevcomp/jevcomp` and carries `.agents/plugins/marketplace.json`; `jevcomp install` is the npm installation path.

## Current restore default

During this audit the default was changed back to preservation-first restore, now named `preserve`, capped at 60,000 characters, because that matches the useful behavior of the base compaction plugins: Jev-selected evidence should actually be available to the model after compaction.

`JEV_COMPACT_RESTORE_MODE=minimal` remains available for aggressive reduction. `balanced` is the middle ground; legacy `index`/`hybrid` names remain aliases. The exact archive is kept on disk in all modes.

## Evidence-driven invariants

- Never remove or mutate user/developer/system text during Jev pruning.
- Only make DROP/TRUNCATE decisions for paired completed tool calls/results.
- Prefer KEEP when independent Jev answers are inconsistent about whether a full result is necessary.
- Do not mark a sidecar ready until native Codex compaction succeeded.
- Consume a ready restore at most once.
- Fall back to native Codex behavior when rollout semantics are known to be unsafe to reconstruct.


## 0.3 performance/correctness pass — 2026-09-22

Validated again against current `openai/codex` main hook schema and rollout item shapes. No architectural behavior from the base projects was removed.

Changes in this pass:

- immutable Jev state is serialized once per compaction instead of once per request batch; provider/key/config resolution is cached per client;
- tool inputs and Jev question objects are built once and reused through fitting/batching; token estimation no longer allocates a regex match array;
- state fitting removes only already-content-free omission markers before merging old call runs, allowing materially larger call histories to fit without dropping additional semantic text;
- post-checkpoint rollout parsing is streamed in chunks instead of loading the entire suffix into a second full string; giant cross-chunk records remain supported;
- history/metrics writes are explicitly best-effort and cannot turn a valid compaction/restore into a functional failure; restore reads the archive before atomically claiming it;
- `PostCompact` persistence failure is fail-open because native compaction has already succeeded;
- archives are written concurrently and `.messages.json` uses compact JSON; the `ready` history row no longer duplicates all Jev decisions;
- Noul outputs outside `[0,1]`, encrypted function arguments, and image-generation context are rejected/fail-open instead of being silently misinterpreted;
- hook numeric configuration is bounded and unknown restore modes fall back to preservation-first `preserve`.

Synthetic local measurements on this environment (not provider/network benchmarks):

- 50 repeated Jev batches sharing a large state: local provider serialization/config path ~136.6 ms -> ~27.1 ms with immutable-state caching; request bytes are unchanged;
- ~20 MB Codex rollout suffix: loader ~85.8 ms / 161.5 MB RSS -> ~63.6 ms / 123.8 MB RSS;
- 300-call synthetic compactor case: ~35.1 ms baseline -> ~23.7 ms in this pass;
- the previous 24k-state-budget synthetic case failed around 400 calls; the revised fitter accepts 600 calls and still rejects 800 when the genuinely minimal Jev state exceeds the configured budget.

These measurements isolate local implementation overhead. They do not claim reductions in TypeSafe/OpenRouter network latency.

## 0.4 usability/dashboard/Codex-compatibility pass — 2026-09-22

Revalidated against current `openai/codex` main during this pass, including hook output spilling, compact lifecycle, plugin placeholder expansion, Windows command execution, and token-budget compaction.

### Dashboard

The previous dashboard inherited the useful shape of `save-token-jev-clean`, but still mixed measured values with derived estimates. The 0.4 dashboard is deliberately stricter:

- shows measured normalized transcript characters before/after **only for retained copies that were actually prepared**;
- shows complete hook-context characters returned after successful restore and the evidence-only payload separately;
- uses provider-reported Jev `input_tokens` / `output_tokens` and request count; low-reduction skips are included because Jev already ran and incurred that usage;
- separates native fallbacks, ordinary skips, pending restores, completed restores, and restore failures;
- groups exact removed characters by tool and exposes recent individual Keep / Shorten / Remove decisions with Jev loss-risk values;
- does **not** derive or label `characters / 4` as Codex billing-token savings;
- remains manual instead of auto-spawning from a compaction hook, so observability does not add a background process to the critical path.

`save-token-jev-clean` remains the inspiration for per-tool/history/decision visibility. `fast-dev-compaction` has no comparable dashboard. The measured-only framing and restore-lifecycle accounting are ours.

### Current Codex `additionalContext` spill

Current Codex applies a generic `additionalContextLimit` to context-producing hooks. When unspecified, the limit is approximately 2,500 tokens; oversized hook output is written to a temporary file and replaced with a bounded head/tail preview plus a recovery path. A value of `0` disables this generic spill.

That behavior matters to jev-compact: a 60,000-character `preserve` restore would otherwise be silently transformed by Codex after our hook returned it. Both packaged hooks and direct-install hooks now set `additionalContextLimit: 0` for `SessionStart` and `UserPromptSubmit` only. jev-compact's own restore mode and `JEV_COMPACT_RESTORE_MAX_CHARS` are therefore the explicit restore-size controls. `PreCompact`/`PostCompact` do not receive this field because they cannot emit additional context.

### Installation

Normal downloaded-release setup is now one command after choosing a provider:

- `jev-compact setup` for TypeSafe;
- `jev-compact setup openrouter` for OpenRouter.

Setup stores the key/provider in the user config directory, copies the compiled `dist/` runtime to a stable `~/.codex/jev-compact/runtime` location, and installs user-level hooks pointing at that stable copy. Moving/deleting the extracted release directory therefore does not break installed hooks. `install` intentionally remains a current-checkout hook install for development/local linking.

The provider/key files are normalized to restrictive file permissions where supported. `doctor` checks provider/key presence and all four required Codex hook events. Environment variables continue to override saved configuration.

Use one installation path at a time: direct/user-hook setup or a future Codex marketplace plugin install. Running both would make Codex discover two hook sources and can duplicate Jev work even though restore consumption itself is one-shot.

### Option naming

The engine now exposes `lossThreshold` as the preferred library option and `JEV_COMPACT_LOSS_THRESHOLD` as the preferred hook setting. This matches the actual Noul questions: the number is the maximum estimated **loss risk** accepted before DROP/TRUNCATE is rejected. `keepThreshold` / `JEV_COMPACT_KEEP_THRESHOLD` remain compatibility aliases.

Preferred restore mode names are `preserve`, `balanced`, and `minimal`; `full`, `hybrid`, and `index` remain aliases. Common-user documentation is limited to restore mode/cap, recent-message pinning, loss threshold, and minimum reduction. Provider concurrency, request/state budgets, timeout/retry, cleanup and TTL remain advanced controls rather than first-run knobs.

### Token-budget compaction

Current Codex's token-budget implementation intentionally starts a new context window without model/server summarization, but still runs the ordinary `PreCompact` / `PostCompact` lifecycle and queues `SessionStart(source=compact)`. jev-compact therefore also preserves selected evidence around token-budget resets. This is documented explicitly: users who enable token-budget specifically to force a fully clean context should not combine that workflow with jev-compact retention.

### Compatibility invariants reconfirmed

- PreCompact never attempts to rewrite the native Codex compaction request.
- PostCompact must succeed before a sidecar becomes restore-eligible.
- SessionStart/UserPromptSubmit restore remains one-shot and stale-safe.
- Current Codex media/encrypted shapes that text-only Jev cannot inspect fail open.
- User/developer/system text remains outside destructive Jev decisions.
- Existing hooks are preserved by the direct installer; only entries tagged `--jev-compact` are replaced/removed.
- Packaged hooks read `PLUGIN_ROOT` from Node's own environment; see the 0.5.3 Windows hook entry below.


## 0.5 post-compaction dedupe / observe pass — 2026-09-23

Two ideas were evaluated against the current Codex lifecycle and implemented only where the host contract provides objective evidence.

### Exact post-compaction membership

`PreCompact` now records the transcript path and exact rollout byte length seen while Jev scores the live history. After native compaction, restore reloads the Codex rollout and enables dedupe only when the newest bounded modern `compacted` checkpoint begins at or after that recorded byte position. Current Codex persists the replacement-history checkpoint before queueing `SessionStart(source=compact)`, which makes this check compatible with the host lifecycle.

Dedupe is deliberately more conservative than prefix/fuzzy matching:

- ordinary text is suppressible only when the same role and full text survive verbatim;
- paired tool evidence is suppressible only when both the exact call (canonical input) and exact result survive under the same call id;
- tool-result equality uses length + full SHA-256 content hash; a matching prefix is insufficient;
- if the checkpoint is stale, absent, on a different rollout path, unsupported, or cannot be parsed, the previous full restore behavior is used.

The retained archive is never mutated. Dedupe changes only the extra context returned after compaction. This makes false negatives cheap (some duplicate text) and avoids dangerous false positives (silently withholding evidence that native compaction actually lost).

### Observe mode

`mode=observe` runs the same real Jev selection at `PreCompact`, persists the same retained archive, waits for successful native compaction, and performs the same post-compaction membership analysis. It then records the hypothetical payload/context size but returns no `additionalContext` to Codex.

Observe therefore changes compaction latency/provider usage but not model context. It is useful for validating the plugin on real sessions before enabling active restoration. `shadow` is accepted as an alias, but `observe` is the documented user-facing term.

Observe also prepares a sidecar when the measured reduction is below `min-reduction-ratio`, marking `wouldApply=false`, so the dashboard can report that active mode would have skipped the restore without changing Codex behavior.

### New measured fields

History/dashboard now distinguish:

- retained evidence selected by Jev;
- exact retained characters already present after native compaction;
- retained characters still missing and restore-eligible;
- actual injected payload/context in active mode;
- hypothetical injected payload/context in observe mode;
- whether membership was verified, stale, or unavailable.

These remain character measurements of the normalized/plugin payloads, not claims about Codex billing-token savings.

## 0.5.3 Windows hook launch fix — 2026-09-24

Real Codex CLI 0.156.1 sessions on Windows showed `Hook failed` for the plugin hooks.

- Evidence: an app-server session (`hook/completed`) reported `hook exited with code 1` for `UserPromptSubmit`; a Node preload trace showed the child received the literal path `<cwd>\%PLUGIN_ROOT%\dist\cli.js`.
- Cause: Codex 0.156.1 runs plugin hooks through the session's user shell (`build_hooks_config` in `core/src/session/mod.rs` derives the shell; `hooks/src/engine/command_runner.rs` falls back to `COMSPEC /C` only without one). With PowerShell as the user shell, `%PLUGIN_ROOT%` is never expanded. `commandWindows` does not imply `cmd.exe`.
- Fix: every hook uses one shell-neutral command, `node -e "import(...process.env.PLUGIN_ROOT...)" jev-compact hook --jev-compact`, with no shell variable syntax. `tests/hooks-manifest.test.mjs` runs it through cmd, Windows PowerShell, pwsh (or `sh`) from an unrelated working directory.
- Separate symptom: `OS Error -1073283067` / `Acesso negado (os error 5)` are spawn errors of the shell itself, before any plugin code. The same Codex process also failed its own `exec_command` with `Failed to create unified exec process: Acesso negado`. Not reproduced afterwards.
- Falsified: launching the Store `pwsh.exe` alias with `CREATE_SUSPENDED`, or from inside a job without breakaway, succeeds on this machine.
- Codex hook trust is hash-based: any change to a hook command marks it `modified` until reviewed in `/hooks`.

## 0.6.0 rename to jevcomp — 2026-09-24

The npm name `jev-compact` belongs to another Jev compaction project, so the package, command, plugin, marketplace, skill, folders and `JEV_COMPACT_*` variables are now `jevcomp`/`JEVCOMP_*`.

- Old variables are copied to the new names at CLI start; `~/.config/jev-compact` is copied once to `~/.config/jevcomp`.
- Hooks tagged `--jev-compact` are still recognized, so setup and plugin migration replace them.
- History from `~/.codex/jev-compact` and `plugins/data/jev-compact-jev-compact` is still read.
- A dashboard started under the old name keeps port 43127 until replaced; the new launcher replaces it when the port is busy with one of ours.
- `npm install -g github:...` on npm 11.16 installs a link to a deleted temporary clone; `--install-links` installs a real copy.

## 0.6.3 observe mode removed — 2026-09-24

Measuring without restoring paid for Jev on every compaction and gave nothing back, so the mode was removed from settings, hooks, history and dashboard.

- A saved `mode` and `JEVCOMP_MODE`/`JEV_COMPACT_MODE` are ignored; every run restores.

## Long-conversation state fitting checked — 2026-09-25

In long conversations the Jev state reaches the `old calls compacted` stage, where each old call is one line with no result text. Measured on the real 1,058,326-character run of 2026-09-25 (301 calls, 299 dropped): re-asking Jev about 15 and then 40 sampled dropped calls with their result previews visible (`full` and `inputs<=200` stages) raised drop risk by about 0.05–0.15, and none crossed the 0.5 threshold. Every decision stayed the same, so per-request states that show each judged result are not worth their cost. Old reads, patches and polling are dropped because they can be reread or rerun, not because Jev cannot see them.

## Claude Code support checked — 2026-09-26

Measured with Claude Code 2.1.283 and a manual `/compact` on a small probe session (hooks logging each event and copying the transcript):

- `PreCompact` saw the complete transcript, including the last answer.
- `SessionStart(source=compact)` fired before `PostCompact`, and before the compaction summary was written to the transcript.
- After compaction the model gets a structured summary that keeps exact values, file lines and every user message, ends by pointing to the full transcript path, and is followed by the recently read files re-attached in full.

Claude Code already recovers what jevcomp restores in Codex, so porting the Codex restore flow adds little. The value there is different: Claude Code 2.1.283 ships an early-access function-hook surface (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, event `session.compact`) that lets a plugin return the kept messages instead of the model-written summary. `tamaratran/fast-jev-compaction` uses it. That replaces the expensive summarization call (US$0.37 for a 42k-token manual `/compact` in this probe) with Jev requests.

## 0.7.0 Claude Code support — 2026-09-26

- `hooks/hooks.json` is now the Claude Code file: a function-hook module (`hooks/claude.js`) plus a `SessionStart` command that starts the dashboard. The Codex hooks moved to `hooks/codex.json`, named by `.codex-plugin/plugin.json`, because Claude Code always loads `hooks/hooks.json` and Codex loads the manifest path instead of it.
- A function-hook module runs without Node (`$` may only be passed to top-level functions), so `hooks/claude.js` runs `node dist/cli.js claude-compact` through `$.process.run`, passing the transcript on stdin. That process runs the same Jev code, settings, key lookup and history as Codex and answers which calls to drop or shorten. Compaction does not depend on the dashboard running, or on its version.
- `precompute` compactions are skipped so Claude Code does not prepare a model-written summary in the background.
- Codex and Claude Code each start their own copy of the dashboard; a running one at the same or a newer version is reused instead of replaced.
- Verified with Claude Code 2.1.283 and `--plugin-dir`: a manual `/compact` went from 47,690 to 7,408 tokens in 550 ms with no summary request.

## 0.7.1 Dashboard per agent — 2026-09-26

- A Codex | Claude Code switch at the top filters the whole dashboard by agent (`/api/stats?agent=`); it appears only when both are installed and defaults to the agent of the latest history row.
- The Claude Code view talks about cutting, not sending, and hides `restore-mode` and `restore-max-chars`, which only the Codex restore flow uses.
- Claude Code installation is read from `~/.claude/plugins/installed_plugins.json` and the function-hook flag in `~/.claude/settings.json`.

## 0.7.3 Codex restore default is `minimal` — 2026-09-26

Codex compaction costs the same with or without jevcomp: its hooks cannot replace the summary, so whatever jevcomp adds back is extra context on every later request. The default restore mode is now `minimal` (the list of what Jev kept and where it is on disk), so Codex pays little context and can open the full text only when it needs it. Saved settings are unchanged; `preserve` and `balanced` remain available.
