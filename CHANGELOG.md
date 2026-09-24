# Changelog

## 0.3.1

### Fixed

- Blocked goals stay blocked until an explicit `/goal resume`, replace, or clear; unrelated user prompts no longer auto-resume them ([#4](https://github.com/code-yeongyu/pi-goal/issues/4)).
- Continuation prompts describe the objective as untrusted goal data instead of user-provided data, because `create_goal` may store a model-inferred objective ([#4](https://github.com/code-yeongyu/pi-goal/issues/4)).

### Changed

- Development and CI now use Bun 1.4.2 (`bun install --frozen-lockfile`, `bun run check`, `bun run test`) with an `npm ci` consumer job.
- Toolchain pins: `@biomejs/biome` 2.5.14, `vitest` 5.0.1, `typescript` 7.0.2, `@types/node` 26.6.2, `@typescript/native-preview` 7.0.0-dev.20260707.2, `@vitest/coverage-v8` 5.0.1.
- Exact `@earendil-works/pi-*` 0.87.1 devDependencies so tests run against the current upstream runtime. Peer ranges stay `*`.
- `engines.node` is now `>=22.19.0`. CI matrix is Node 22/24 on ubuntu-latest and macos-latest.

## 0.3.0

### Breaking

- `update_goal` now accepts only `complete` or `blocked`; blocking requires a non-empty `reason`, while completion rejects one.

### Added

- Completed goals can be replaced through `create_goal`; the previous goal is archived in per-thread JSONL history.
- Oversized objectives are marker-budget truncated and their full text is saved in a per-thread spill file.
- Blocked goal state, interruption blocking, next-user-message auto-resume, and continuation suppression.
- Streamed mid-turn usage accounting and inert `tokenBudget` persistence for wire compatibility.
