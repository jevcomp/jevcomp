# Architecture audit

Audit date: 2026-09-29.

## Codex

Codex runs through `jevcomp codex`, implemented in `src/codex-proxy.ts`. The local proxy handles supported compaction requests with Jev's selection when it meets the configured minimum reduction, and forwards requests that Jev cannot safely handle. `jevcomp install ... codex` records the installation in the user config directory; the dashboard reads Codex history from that marker and `history.jsonl`.

## Claude Code

Claude Code keeps its plugin entrypoints in `hooks/hooks.json` and `hooks/claude.js`. The function hook calls the shared compaction implementation and leaves the conversation intact when the host does not provide a supported transcript. `src/claude-compact.ts` shares provider settings and history with the dashboard.

## Antigravity

Antigravity runs through `jevcomp agy`, where a local TLS proxy compacts Gemini-style generation requests before they reach the model. The adapter preserves function/tool calls, IDs, signatures, and unknown host fields; a Jev `drop_call` decision is projected to result-only omission because removing the Gemini call itself would break host invariants.

Antigravity audit is available with `jevcomp audit enable agy --mode metadata|evidence`. It records only fresh Jev evaluations as decision cases, tracks cached decision reuse separately, and distinguishes the core action selected by Jev from the action the Antigravity adapter can safely apply. Continuation analysis uses a local journal of requests actually forwarded upstream, not the raw inbound history that Antigravity may resend. A transport failure therefore remains unconfirmed and is not journaled as model-visible context.

In `metadata` mode the outbound journal stores hashes, sizes, tool identities, and decision provenance without conversation text. In `evidence` mode it also stores the normalized model-visible messages needed for local reappearance analysis and case inspection.

## Shared components

- `src/compact.ts` selects old command output to keep, shorten, or remove.
- `src/provider.ts` resolves saved keys, environment overrides, and provider transports.
- `src/store.ts` records history used by the dashboard.
- `src/dashboard.ts` reports measured transcript characters and provider-reported Jev usage; it does not estimate billing-token savings.

## Validation

The repository test command builds the TypeScript sources and runs the Node test suite. `npx tsc --noEmit` checks the source without producing output.
