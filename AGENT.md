# AGENT.md

- Use Git from the start; commit small checkpoints.
- Prefer Codex correctness and measurable token reduction.
- Keep code simple, fast, dependency-light, and easy to install.
- Support TypeSafe Jev directly and OpenRouter-compatible provider configuration.
- Preserve system/developer/user/assistant text verbatim; only prune completed tool calls/results.
- Parse Codex rollout compaction records so decisions use the live transcript.
- Fail open to native Codex compaction.
- Add tests for adapters, compaction, hooks, and provider transports.
- Avoid unnecessary comments; explain only non-obvious reasons.

## Session 2026-10-08
- Implement Jev compaction batching so oversized histories are judged incrementally instead of failing at maxStateTokens.
- Bound batch concurrency to 2 and use one 60s wall-clock deadline with cancellation propagated into Jev provider retries.
- Candidates too large to fit the request budget alone default to drop_call, while fittable candidates continue to be grouped and judged by Jev normally.
- Guarantee fail-open on provider/batch errors without unhandled promise rejections; oversized single candidates still default to drop_call by design.
- Do not add tests for this change.
- Preserve fail-open behavior and existing public configuration.
- Compile/validate TypeScript only; no new test files.
- Keep the Claude inference gateway persistent on 127.0.0.1:16392 so background/resumed sessions survive wrapper restarts.
- Keep Codex and Antigravity jevcomp proxies persistent on stable loopback ports so native background/resume modes do not outlive their interception endpoint. 
