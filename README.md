# pi-goal

Persistent `/goal` support for pi. The extension ports the useful parts of Codex goal mode into a pi package: a session-scoped goal store, Codex-style TUI footer indicator, hidden continuation prompts, token/time accounting, and agent-callable tools.

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
/goal <objective>
/goal
/goal pause
/goal resume
/goal clear
```

Goals are stored under Pi's active session directory, keyed by session id. If Pi is launched without a persisted session, the extension falls back to `$PI_CODING_AGENT_DIR/extensions/pi-goal/...`. That means `PI_CODING_AGENT_DIR=$HOME/.senpi/agent` keeps goal state under `~/.senpi/agent/...` even when pi is launched from a workspace such as `~/local-workspaces/senpi-mono`.

## Agent Tools

- `create_goal({ objective })` creates a new active goal. Objectives are limited to 4,000 characters; oversized objectives are truncated with the full text saved beside the goal store.
- `update_goal({ status: "complete" })` marks the current goal complete.
- `update_goal({ status: "blocked", reason })` records a repeated blocking condition and its reason.
- `get_goal({})` returns the current goal summary.

Statuses are `active`, `paused`, `blocked`, and `complete`. Pause and resume remain user/system controlled.

## TUI Behavior

When a goal exists, pi keeps the normal footer information and renders the Codex-style goal indicator on the bottom-right footer line: `Pursuing goal (...)`, `Goal paused (/goal resume)`, `Goal blocked`, or `Goal achieved (...)`. The older below-editor goal widget is cleared.

On session start, after `/goal <objective>`, after `/goal resume`, and after every agent turn that leaves the goal `active`, the extension queues Codex's goal continuation prompt as hidden model-visible context. The objective is XML-escaped and wrapped as untrusted user data so it does not become higher-priority instructions.

## Blocked goals

Use `update_goal` with `status: "blocked"` only after the same blocking condition has recurred for at least three consecutive goal turns. A resumed goal starts a fresh audit; do not block a goal merely because work is hard, slow, or uncertain.

If an active turn ends with `ctx.signal.aborted`, pi-goal records `user interrupted the turn` and suppresses continuation. The next real user prompt resumes that blocked goal before accounting starts; goal-continuation messages do not resume it. The published extension API exposes no abort source, so this `ctx.signal` heuristic cannot distinguish user-initiated aborts from system aborts and may label a non-user abort as `user interrupted the turn`. Follow-up: upstream an `aborted` flag and abort-source field in the published extension API.

## Development

```bash
npm test
npm run typecheck
npm run check
npm run no-excuse
npm pack --dry-run
```

The implementation is strict TypeScript and mirrors sibling pi extension metadata, CI, and package layout. `npm run check` runs `tsgo --noEmit`, `biome check .`, and the TypeScript no-excuse checker.

## Related

- [senpi](https://github.com/code-yeongyu/senpi) — the fork/runtime these extensions are extracted from.
- [Ultraworkers Discord](https://discord.gg/PUwSMR9XNk) — community link from the senpi README.
- [Dori](https://sisyphuslabs.ai) — the product powered by senpi under the hood.
