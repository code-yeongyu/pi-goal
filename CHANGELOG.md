# Changelog

## 0.3.0

### Breaking

- `update_goal` now accepts only `complete` or `blocked`; blocking requires a non-empty `reason`, while completion rejects one.

### Added

- Completed goals can be replaced through `create_goal`; the previous goal is archived in per-thread JSONL history.
- Oversized objectives are marker-budget truncated and their full text is saved in a per-thread spill file.
- Blocked goal state, interruption blocking, next-user-message auto-resume, and continuation suppression.
- Streamed mid-turn usage accounting and inert `tokenBudget` persistence for wire compatibility.
