import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { parseGoalCommand } from "./goal/command.js";
import { shouldQueueGoalContinuationAfterAgentEnd, shouldQueueGoalContinuationWhenIdle } from "./goal/continuation.js";
import { formatGoalForTool, formatGoalToolResponse, goalStatusLabel } from "./goal/format.js";
import { buildContinuationPrompt } from "./goal/prompt.js";
import {
	accountGoalUsage,
	clearGoal,
	createGoal,
	objectiveFullTextFileName,
	readGoal,
	updateGoal,
} from "./goal/store.js";
import type { Goal, GoalAccountingMode, GoalStoreRef, TokenUsageSnapshot } from "./goal/types.js";
import { isRecord, MODEL_SETTABLE_GOAL_STATUS_VALUES } from "./goal/types.js";
import { updateGoalUi } from "./goal/ui.js";
import { objectiveTruncationNotice, validateObjective } from "./goal/validation.js";

const GOAL_USAGE = "Usage: /goal <objective>";
const GOAL_EMPTY_HINT = "No goal is currently set.";
const GOAL_CONTINUATION_MESSAGE_TYPE = "pi-goal-continuation";
const REPLACE_GOAL_CHOICE = "Replace current goal";
const CANCEL_REPLACE_GOAL_CHOICE = "Cancel";
const RESUME_GOAL_CHOICE = "Resume goal";
const LEAVE_GOAL_PAUSED_CHOICE = "Leave paused";
const EMPTY_USAGE: TokenUsageSnapshot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
const STALE_EXTENSION_CONTEXT_ERROR_PREFIX = "This extension ctx is stale after session replacement or reload.";

type GoalToolResult = AgentToolResult<Record<string, never>>;
type AssistantUsageMessage = {
	role: "assistant";
	usage: Record<string, unknown>;
};
type AgentGoalAccounting = {
	goalId: string;
	measuredFromMilliseconds: number;
};

export default function (pi: ExtensionAPI): void {
	let agentTurnInProgress = false;
	let agentGoalAccounting: AgentGoalAccounting | null = null;
	let blockedThisTurnGoalId: string | null = null;
	let completedThisTurnGoalId: string | null = null;

	pi.registerTool({
		name: "create_goal",
		label: "Create Goal",
		description:
			"Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.\nObjectives are limited to 4,000 characters. For longer instructions, put the full objective in a file and refer to that file.\nReplaces the current goal when it is complete and archives it; fails if an unfinished goal exists.",
		parameters: Type.Object(
			{
				objective: Type.String({
					description:
						"Required. The concrete objective to start pursuing. Limit: 4,000 characters. For longer instructions, put the full objective in a file and refer to that file.",
				}),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const ref = goalStoreRef(ctx);
			const current = await readGoal(ref);
			if (current !== null && current.status !== "complete") {
				throw new Error(
					"cannot create a new goal because this thread already has an unfinished goal; use update_goal only when the existing goal is complete",
				);
			}
			const validatedObjective = validateObjective(params.objective, objectiveFullTextFileName(ref));
			const goal = await createGoal(ref, params.objective);
			beginAgentGoalAccounting(goal);
			updateGoalUi(ctx, goal);
			return toolText(
				formatGoalToolResponse(
					goal,
					validatedObjective.truncated ? objectiveTruncationNotice(objectiveFullTextFileName(ref)) : undefined,
				),
			);
		},
	});

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description:
			"Update the existing goal.\nSet status to `complete` only when the objective has actually been achieved and no required work remains. Do not mark a goal complete merely because you are stopping work.\nSet status to `blocked` only after the same blocking condition recurs for at least 3 consecutive goal turns. After resuming, begin a fresh blocked audit after resume. Never mark a goal blocked merely because the work is hard, slow, or uncertain.\nA non-empty reason is required when blocking; reason must not be provided when completing.\nYou cannot use this tool to pause or resume a goal; those status changes are controlled by the user or system.\nWhen marking the goal achieved with status `complete`, report the final elapsed time and token usage from the tool result to the user.",
		parameters: Type.Object(
			{
				status: Type.Union(
					MODEL_SETTABLE_GOAL_STATUS_VALUES.map((status) => Type.Literal(status)),
					{
						description: "Required. Set to complete when achieved or blocked with a non-empty reason.",
					},
				),
				reason: Type.Optional(
					Type.String({
						description: "Required and non-empty when status is blocked; rejected when status is complete.",
					}),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const reason = params.reason?.trim();
			if (params.status === "blocked" && (reason === undefined || reason.length === 0)) {
				throw new Error("reason is required when status is blocked");
			}
			if (params.status === "complete" && params.reason !== undefined) {
				throw new Error("reason must not be provided when status is complete");
			}
			await accountCurrentAgentTurn(ctx, EMPTY_USAGE, "active");
			const goal = await updateGoal(
				goalStoreRef(ctx),
				params.status === "blocked"
					? { status: "blocked", ...(reason === undefined ? {} : { reason }) }
					: { status: "complete" },
				"model",
			);
			if (goal.status === "blocked") {
				markGoalBlockedThisTurn(goal);
			} else {
				markGoalCompletedThisTurn(goal);
			}
			updateGoalUi(ctx, goal);
			return toolText(formatGoalToolResponse(goal));
		},
	});

	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Get the current goal for this thread, including status, token and elapsed-time usage.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const goal = await readGoal(goalStoreRef(ctx));
			updateGoalUi(ctx, goal);
			return toolText(formatGoalToolResponse(goal));
		},
	});

	pi.registerCommand("goal", {
		description: "Set, inspect, pause, resume, or clear the persistent goal",
		handler: async (rawArgs, ctx) => {
			const command = parseGoalCommand(rawArgs);
			try {
				switch (command.kind) {
					case "show": {
						const goal = await readGoal(goalStoreRef(ctx));
						updateGoalUi(ctx, goal);
						ctx.ui.notify(
							goal === null ? `${GOAL_USAGE}\n${GOAL_EMPTY_HINT}` : formatGoalForTool(goal),
							goal ? "info" : "warning",
						);
						return;
					}
					case "setObjective": {
						await setGoalObjective(pi, ctx, command.objective);
						return;
					}
					case "setStatus": {
						if (command.status === "paused") {
							await accountCurrentAgentTurn(ctx, EMPTY_USAGE, "active");
						}
						const goal = await updateGoal(goalStoreRef(ctx), { status: command.status }, "user");
						if (goal.status === "active") {
							beginAgentGoalAccounting(goal);
						} else {
							stopAgentGoalAccounting(goal.id);
						}
						updateGoalUi(ctx, goal);
						ctx.ui.notify(`Goal ${goalStatusLabel(goal.status)}\n${formatGoalForTool(goal)}`, "info");
						queueGoalContinuation(pi, ctx, goal);
						return;
					}
					case "clear": {
						await accountCurrentAgentTurn(ctx, EMPTY_USAGE, "active");
						const cleared = await clearGoal(goalStoreRef(ctx));
						clearAgentGoalAccounting();
						updateGoalUi(ctx, null);
						ctx.ui.notify(
							cleared ? "Goal cleared" : "No goal to clear\nThis thread does not currently have a goal.",
							cleared ? "info" : "warning",
						);
						return;
					}
				}
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	pi.on("session_start", async (event, ctx) => {
		const goal = await readGoal(goalStoreRef(ctx));
		if (goal?.status === "active") {
			beginAgentGoalAccounting(goal);
		} else {
			clearAgentGoalAccounting();
		}
		updateGoalUi(ctx, goal);
		if (await maybePromptResumePausedGoal(pi, ctx, event.reason, goal)) {
			return;
		}
		if (shouldQueueGoalContinuationWhenIdle(goal, ctx.isIdle(), ctx.hasPendingMessages())) {
			queueHiddenGoalPrompt(pi, buildContinuationPrompt(goal));
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		agentTurnInProgress = true;
		blockedThisTurnGoalId = null;
		completedThisTurnGoalId = null;
		const goal = await readGoal(goalStoreRef(ctx));
		if (goal?.status === "active") {
			beginAgentGoalAccounting(goal);
		} else {
			agentGoalAccounting = null;
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		const mode: GoalAccountingMode =
			blockedThisTurnGoalId !== null
				? "activeOrBlocked"
				: completedThisTurnGoalId === null
					? "active"
					: "activeOrComplete";
		const goal = await accountCurrentAgentTurn(ctx, collectAssistantUsage(event.messages), mode);
		agentTurnInProgress = false;
		blockedThisTurnGoalId = null;
		completedThisTurnGoalId = null;
		if (goal?.status === "active") {
			beginAgentGoalAccounting(goal);
		} else {
			clearAgentGoalAccounting();
		}
		updateGoalUiBestEffort(ctx, goal);
		if (goal?.status === "active" && shouldQueueGoalContinuationAfterAgentEnd(goal, ctx.hasPendingMessages())) {
			queueHiddenGoalPrompt(pi, buildContinuationPrompt(goal));
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (agentGoalAccounting !== null) {
			await accountCurrentAgentTurn(ctx, EMPTY_USAGE, "active");
		}
		clearAgentGoalAccounting();
	});

	async function setGoalObjective(pi: ExtensionAPI, ctx: ExtensionContext, objective: string): Promise<void> {
		const ref = goalStoreRef(ctx);
		const current = await readGoal(ref);
		if (current !== null) {
			const shouldReplace = await confirmReplaceGoal(ctx, objective);
			if (!shouldReplace) return;
		}

		if (current?.status === "active") {
			await accountCurrentAgentTurn(ctx, EMPTY_USAGE, "active");
		}
		const goal = current === null ? await createGoal(ref, objective) : await updateGoal(ref, { objective }, "user");
		if (goal.status === "active") beginAgentGoalAccounting(goal);
		updateGoalUi(ctx, goal);
		ctx.ui.notify(`Goal ${goalStatusLabel(goal.status)}\n${formatGoalForTool(goal)}`, "info");
		queueGoalContinuation(pi, ctx, goal);
	}

	async function confirmReplaceGoal(ctx: ExtensionContext, objective: string): Promise<boolean> {
		if (!ctx.hasUI) return true;
		const choice = await ctx.ui.select(`Replace goal?\nNew objective: ${objective}`, [
			REPLACE_GOAL_CHOICE,
			CANCEL_REPLACE_GOAL_CHOICE,
		]);
		return choice === REPLACE_GOAL_CHOICE;
	}

	async function maybePromptResumePausedGoal(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		sessionStartReason: string,
		goal: Goal | null,
	): Promise<boolean> {
		if (!isResumeOfPausedGoal(ctx, sessionStartReason, goal)) {
			return false;
		}

		const choice = await ctx.ui.select(`Resume paused goal?\nGoal: ${goal.objective}`, [
			RESUME_GOAL_CHOICE,
			LEAVE_GOAL_PAUSED_CHOICE,
		]);
		if (choice !== RESUME_GOAL_CHOICE) return true;

		const resumed = await updateGoal(goalStoreRef(ctx), { status: "active" }, "user");
		beginAgentGoalAccounting(resumed);
		updateGoalUi(ctx, resumed);
		ctx.ui.notify(`Goal ${goalStatusLabel(resumed.status)}\n${formatGoalForTool(resumed)}`, "info");
		queueGoalContinuation(pi, ctx, resumed);
		return true;
	}

	function beginAgentGoalAccounting(goal: Goal): void {
		if (goal.status !== "active") return;
		if (agentGoalAccounting?.goalId === goal.id) return;
		agentGoalAccounting = { goalId: goal.id, measuredFromMilliseconds: Date.now() };
	}

	function markGoalBlockedThisTurn(goal: Goal): void {
		if (!agentTurnInProgress) return;
		blockedThisTurnGoalId = goal.id;
	}

	function markGoalCompletedThisTurn(goal: Goal): void {
		if (!agentTurnInProgress) return;
		completedThisTurnGoalId = goal.id;
		agentGoalAccounting = { goalId: goal.id, measuredFromMilliseconds: Date.now() };
	}

	function stopAgentGoalAccounting(goalId: string): void {
		if (agentGoalAccounting?.goalId === goalId) {
			agentGoalAccounting = null;
		}
		if (blockedThisTurnGoalId === goalId) {
			blockedThisTurnGoalId = null;
		}
		if (completedThisTurnGoalId === goalId) {
			completedThisTurnGoalId = null;
		}
	}

	function clearAgentGoalAccounting(): void {
		agentGoalAccounting = null;
		blockedThisTurnGoalId = null;
		completedThisTurnGoalId = null;
	}

	async function accountCurrentAgentTurn(
		ctx: ExtensionContext,
		usage: TokenUsageSnapshot,
		mode: GoalAccountingMode,
	): Promise<Goal | null> {
		const accounting = agentGoalAccounting;
		const ref = goalStoreRef(ctx);
		if (accounting === null) return readGoal(ref);

		const now = Date.now();
		const elapsedSeconds = Math.max(0, Math.round((now - accounting.measuredFromMilliseconds) / 1000));
		const goal = await accountGoalUsage(ref, usage, elapsedSeconds, mode, accounting.goalId);
		if (goal?.id === accounting.goalId) {
			agentGoalAccounting = { goalId: accounting.goalId, measuredFromMilliseconds: now };
		} else {
			clearAgentGoalAccounting();
		}
		return goal;
	}
}

function updateGoalUiBestEffort(ctx: ExtensionContext, goal: Goal | null): void {
	try {
		updateGoalUi(ctx, goal);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith(STALE_EXTENSION_CONTEXT_ERROR_PREFIX)) {
			return;
		}
		throw error;
	}
}

function isResumeOfPausedGoal(ctx: ExtensionContext, sessionStartReason: string, goal: Goal | null): goal is Goal {
	return (
		sessionStartReason === "resume" &&
		goal?.status === "paused" &&
		ctx.hasUI &&
		ctx.isIdle() &&
		!ctx.hasPendingMessages()
	);
}

function queueGoalContinuation(pi: ExtensionAPI, ctx: ExtensionContext, goal: Goal): void {
	if (shouldQueueGoalContinuationWhenIdle(goal, ctx.isIdle(), ctx.hasPendingMessages())) {
		queueHiddenGoalPrompt(pi, buildContinuationPrompt(goal));
	}
}

function queueHiddenGoalPrompt(pi: ExtensionAPI, content: string): void {
	pi.sendMessage(
		{ customType: GOAL_CONTINUATION_MESSAGE_TYPE, content, display: false },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
}

function goalStoreRef(ctx: ExtensionContext): GoalStoreRef {
	const sessionFile = ctx.sessionManager.getSessionFile();
	const baseDir =
		sessionFile === undefined
			? join(agentDir(), "extensions", "pi-goal", "no-session", cwdStoreKey(ctx.cwd))
			: join(ctx.sessionManager.getSessionDir(), "extensions", "pi-goal");

	return {
		baseDir,
		threadId: ctx.sessionManager.getSessionId(),
	};
}

function agentDir(): string {
	return process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
}

function cwdStoreKey(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 24);
}

function toolText(text: string): GoalToolResult {
	return { content: [{ type: "text" as const, text }], details: {} };
}

function collectAssistantUsage(messages: unknown[]): TokenUsageSnapshot {
	const usage: TokenUsageSnapshot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
	for (const message of messages) {
		if (!isAssistantUsageMessage(message)) continue;
		usage.input += numericUsageField(message.usage, "input");
		usage.output += numericUsageField(message.usage, "output");
		usage.cacheRead += numericUsageField(message.usage, "cacheRead");
		usage.cacheWrite += numericUsageField(message.usage, "cacheWrite");
		usage.totalTokens += numericUsageField(message.usage, "totalTokens");
	}
	return usage;
}

function isAssistantUsageMessage(message: unknown): message is AssistantUsageMessage {
	if (!isRecord(message)) return false;
	return message["role"] === "assistant" && isRecord(message["usage"]);
}

function numericUsageField(usage: Record<string, unknown>, key: string): number {
	const value = usage[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
