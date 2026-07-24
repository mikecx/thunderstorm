# CLAUDE.md

See [AGENTS.md](AGENTS.md) for architecture, load-bearing design decisions, and testing conventions — it applies equally here and is kept as the single source of truth to avoid the two drifting apart.

Quick pointers specific to working in this repo with Claude Code:

- Run `npx tsc --noEmit && npm run lint && npm run format:check && npm test` before considering any change done — same checks CI runs.
- `npm run demo` ([src/example/demo.ts](src/example/demo.ts)) is the fastest way to sanity-check a change against a real (in-memory) database end-to-end.
- [README.md](README.md) is the feature reference for users of the library; AGENTS.md is about the internals. Update both when a change affects either.
