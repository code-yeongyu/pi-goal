# pi-goal

Persistent `/goal` support for pi. The extension ports the useful parts of Codex goal mode into a pi package: a project-local goal store, TUI status/widget, goal-aware system steering, continuation prompts, token/time accounting, and agent-callable tools.

## Installation

```bash
pi install npm:pi-goal
```

For local development:

```bash
pi -e ./src/index.ts
```

## Commands

```bash
/goal set <objective> [--token-budget N]
/goal status
/goal pause
/goal resume
/goal complete
/goal clear
```

Goals are stored in `.pi/goal.json` in the current project. The file is intentionally local state and is ignored by this repository.

## Agent Tools

- `create_goal({ objective, token_budget? })` creates a new active goal. This follows Codex's model-facing schema.
- `update_goal({ status: "complete" })` only marks the current goal complete. Pause, resume, budget-limited, and clear transitions are user/system controlled.
- `get_goal({})` returns the current goal summary.

Statuses are `active`, `paused`, `budget_limited`, and `complete`. When a goal reaches its token budget, the extension marks it `budget_limited` and queues a prompt asking the agent to summarize remaining work instead of silently continuing.

## TUI Behavior

When a goal is active, pi shows a compact status line and a below-editor widget with objective, status, elapsed time, and token usage. Each active turn receives a system prompt requiring a completion audit before the agent may call `update_goal` with `status: "complete"`.

On session start, an active goal queues a continuation prompt modeled after Codex's goal continuation behavior. The objective is wrapped as untrusted user data so it does not become higher-priority instructions.

## Development

```bash
npm test
npm run typecheck
npm run check
npm run no-excuse
npm pack --dry-run
```

The implementation is strict TypeScript and mirrors sibling pi extension metadata, CI, and package layout. `npm run check` runs `tsgo --noEmit`, `biome check .`, and the TypeScript no-excuse checker.
