import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { shouldQueueGoalContinuationAfterAgentEnd, shouldQueueGoalContinuationWhenIdle } from "./continuation.js";
import { formatGoalForTool, goalStatusLabel } from "./format.js";
import { buildContinuationPrompt } from "./prompt.js";
import { accountGoalUsage, readGoal, updateGoal } from "./store.js";
import type { Goal, GoalAccountingMode, GoalStoreRef, TokenUsageSnapshot } from "./types.js";
import { isRecord } from "./types.js";
import { updateGoalUi } from "./ui.js";

const GOAL_CONTINUATION_MESSAGE_TYPE = "pi-goal-continuation";
const RESUME_GOAL_CHOICE = "Resume goal";
const LEAVE_GOAL_PAUSED_CHOICE = "Leave paused";
const STALE_EXTENSION_CONTEXT_ERROR_PREFIX = "This extension ctx is stale after session replacement or reload.";
const EMPTY_USAGE: TokenUsageSnapshot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

type AgentGoalAccounting = {
	goalId: string;
	measuredFromMilliseconds: number;
};

type AssistantUsageMessage = {
	role: "assistant";
	usage: Record<string, unknown>;
};

export type GoalLifecycle = {
	beginAgentGoalAccounting(goal: Goal): void;
	markGoalBlockedThisTurn(goal: Goal): void;
	markGoalCompletedThisTurn(goal: Goal): void;
	stopAgentGoalAccounting(goalId: string): void;
	clearAgentGoalAccounting(): void;
	accountCurrentAgentTurn(
		ctx: ExtensionContext,
		usage: TokenUsageSnapshot,
		mode: GoalAccountingMode,
	): Promise<Goal | null>;
	queueGoalContinuation(ctx: ExtensionContext, goal: Goal): void;
};

export function registerGoalLifecycle(
	pi: ExtensionAPI,
	goalStoreRef: (ctx: ExtensionContext) => GoalStoreRef,
): GoalLifecycle {
	let agentTurnInProgress = false;
	let agentGoalAccounting: AgentGoalAccounting | null = null;
	let blockedThisTurnGoalId: string | null = null;
	let completedThisTurnGoalId: string | null = null;
	let nextAgentStartWasUserTriggered = false;
	let agentAbortSignal: AbortSignal | undefined;

	pi.on("session_start", async (event, ctx) => {
		const goal = await readGoal(goalStoreRef(ctx));
		if (goal?.status === "active") {
			beginAgentGoalAccounting(goal);
		} else {
			clearAgentGoalAccounting();
		}
		updateGoalUi(ctx, goal);
		if (await maybePromptResumePausedGoal(ctx, event.reason, goal)) return;
		if (shouldQueueGoalContinuationWhenIdle(goal, ctx.isIdle(), ctx.hasPendingMessages())) {
			queueHiddenGoalPrompt(pi, buildContinuationPrompt(goal));
		}
	});

	pi.on("before_agent_start", async () => {
		nextAgentStartWasUserTriggered = true;
	});

	pi.on("agent_start", async (_event, ctx) => {
		const userTriggered = nextAgentStartWasUserTriggered;
		nextAgentStartWasUserTriggered = false;
		agentAbortSignal = ctx.signal;
		agentTurnInProgress = true;
		blockedThisTurnGoalId = null;
		completedThisTurnGoalId = null;
		let goal = await readGoal(goalStoreRef(ctx));
		if (userTriggered && goal?.status === "blocked") {
			goal = await updateGoal(goalStoreRef(ctx), { status: "active" }, "user");
		}
		if (goal?.status === "active") {
			beginAgentGoalAccounting(goal);
		} else {
			agentGoalAccounting = null;
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		const aborted = agentAbortSignal?.aborted === true;
		const mode: GoalAccountingMode =
			blockedThisTurnGoalId !== null
				? "activeOrBlocked"
				: completedThisTurnGoalId === null
					? "active"
					: "activeOrComplete";
		let goal = await accountCurrentAgentTurn(ctx, collectAssistantUsage(event.messages), mode);
		agentTurnInProgress = false;
		blockedThisTurnGoalId = null;
		completedThisTurnGoalId = null;
		agentAbortSignal = undefined;
		if (aborted && goal?.status === "active") {
			goal = await updateGoal(
				goalStoreRef(ctx),
				{ status: "blocked", reason: "user interrupted the turn" },
				"model",
			);
		}
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
		if (agentGoalAccounting !== null) await accountCurrentAgentTurn(ctx, EMPTY_USAGE, "active");
		clearAgentGoalAccounting();
	});

	return {
		beginAgentGoalAccounting,
		markGoalBlockedThisTurn,
		markGoalCompletedThisTurn,
		stopAgentGoalAccounting,
		clearAgentGoalAccounting,
		accountCurrentAgentTurn,
		queueGoalContinuation,
	};

	async function maybePromptResumePausedGoal(
		ctx: ExtensionContext,
		sessionStartReason: string,
		goal: Goal | null,
	): Promise<boolean> {
		if (!isResumeOfPausedGoal(ctx, sessionStartReason, goal)) return false;
		const choice = await ctx.ui.select(`Resume paused goal?\nGoal: ${goal.objective}`, [
			RESUME_GOAL_CHOICE,
			LEAVE_GOAL_PAUSED_CHOICE,
		]);
		if (choice !== RESUME_GOAL_CHOICE) return true;

		const resumed = await updateGoal(goalStoreRef(ctx), { status: "active" }, "user");
		beginAgentGoalAccounting(resumed);
		updateGoalUi(ctx, resumed);
		ctx.ui.notify(`Goal ${goalStatusLabel(resumed.status)}\n${formatGoalForTool(resumed)}`, "info");
		queueGoalContinuation(ctx, resumed);
		return true;
	}

	function beginAgentGoalAccounting(goal: Goal): void {
		if (goal.status !== "active" || agentGoalAccounting?.goalId === goal.id) return;
		agentGoalAccounting = { goalId: goal.id, measuredFromMilliseconds: Date.now() };
	}

	function markGoalBlockedThisTurn(goal: Goal): void {
		if (agentTurnInProgress) blockedThisTurnGoalId = goal.id;
	}

	function markGoalCompletedThisTurn(goal: Goal): void {
		if (!agentTurnInProgress) return;
		completedThisTurnGoalId = goal.id;
		agentGoalAccounting = { goalId: goal.id, measuredFromMilliseconds: Date.now() };
	}

	function stopAgentGoalAccounting(goalId: string): void {
		if (agentGoalAccounting?.goalId === goalId) agentGoalAccounting = null;
		if (blockedThisTurnGoalId === goalId) blockedThisTurnGoalId = null;
		if (completedThisTurnGoalId === goalId) completedThisTurnGoalId = null;
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

	function queueGoalContinuation(ctx: ExtensionContext, goal: Goal): void {
		if (shouldQueueGoalContinuationWhenIdle(goal, ctx.isIdle(), ctx.hasPendingMessages())) {
			queueHiddenGoalPrompt(pi, buildContinuationPrompt(goal));
		}
	}
}

function updateGoalUiBestEffort(ctx: ExtensionContext, goal: Goal | null): void {
	try {
		updateGoalUi(ctx, goal);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith(STALE_EXTENSION_CONTEXT_ERROR_PREFIX)) return;
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

function queueHiddenGoalPrompt(pi: ExtensionAPI, content: string): void {
	pi.sendMessage(
		{ customType: GOAL_CONTINUATION_MESSAGE_TYPE, content, display: false },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
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
	return isRecord(message) && message["role"] === "assistant" && isRecord(message["usage"]);
}

function numericUsageField(usage: Record<string, unknown>, key: string): number {
	const value = usage[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
