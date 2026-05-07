import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { parseGoalCommand } from "./goal/command.js";
import { formatGoalForTool, formatGoalToolResponse, goalStatusLabel } from "./goal/format.js";
import { buildBudgetLimitedPrompt, buildContinuationPrompt, buildGoalSystemPrompt } from "./goal/prompt.js";
import { accountGoalUsage, clearGoal, createGoal, readGoal, updateGoal } from "./goal/store.js";
import type { Goal, GoalStoreRef, TokenUsageSnapshot } from "./goal/types.js";
import { COMPLETABLE_GOAL_STATUS_VALUES } from "./goal/types.js";
import { updateGoalUi } from "./goal/ui.js";

const GOAL_USAGE = "Usage: /goal <objective>";
const GOAL_USAGE_HINT = "Example: /goal improve benchmark coverage";

type GoalToolResult = AgentToolResult<Record<string, never>> & { isError?: boolean };
type AssistantUsageMessage = {
	role: "assistant";
	usage: Record<string, unknown>;
};

export default function (pi: ExtensionAPI): void {
	let agentStartedAt: number | null = null;

	async function refreshUi(ctx: ExtensionContext): Promise<void> {
		updateGoalUi(ctx, await readGoal(goalStoreRef(ctx)));
	}

	pi.registerTool({
		name: "create_goal",
		label: "Create Goal",
		description:
			"Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks.\nSet token_budget only when an explicit token budget is requested. Fails if a goal exists; use update_goal only for status.",
		promptSnippet:
			"Create a persistent goal only when explicitly requested by the user or higher-priority instructions.",
		promptGuidelines: [
			"Create a goal only when explicitly requested by the user or system/developer instructions.",
			"Do not create goals for ordinary one-turn tasks.",
		],
		parameters: Type.Object(
			{
				objective: Type.String({
					description:
						"Required. The concrete objective to start pursuing. This starts a new active goal only when no goal is currently defined; if a goal already exists, this tool fails.",
				}),
				token_budget: Type.Optional(
					Type.Integer({ description: "Optional positive token budget for the new active goal." }),
				),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const ref = goalStoreRef(ctx);
			if ((await readGoal(ref)) !== null) {
				return toolText(
					"cannot create a new goal because this thread already has a goal; use update_goal only when the existing goal is complete",
					true,
				);
			}
			const goal = await createGoal(ref, params.objective, params.token_budget);
			updateGoalUi(ctx, goal);
			return toolText(formatGoalToolResponse(goal, false));
		},
	});

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description:
			"Update the existing goal.\nUse this tool only to mark the goal achieved.\nSet status to `complete` only when the objective has actually been achieved and no required work remains.\nDo not mark a goal complete merely because its budget is nearly exhausted or because you are stopping work.\nYou cannot use this tool to pause, resume, or budget-limit a goal; those status changes are controlled by the user or system.\nWhen marking a budgeted goal achieved with status `complete`, report the final token usage from the tool result to the user.",
		promptSnippet: "Mark the persistent goal complete only after verifying no required work remains.",
		promptGuidelines: [
			"Only mark a goal complete after auditing the actual current state against the user's objective.",
			"Do not call update_goal because the budget is exhausted or because work is stopping for another reason.",
		],
		parameters: Type.Object(
			{
				status: Type.Union(
					COMPLETABLE_GOAL_STATUS_VALUES.map((status) => Type.Literal(status)),
					{
						description:
							"Required. Set to complete only when the objective is achieved and no required work remains.",
					},
				),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.status !== "complete") {
				return toolText(
					"update_goal can only mark the existing goal complete; pause, resume, and budget-limited status changes are controlled by the user or system",
					true,
				);
			}
			const goal = await updateGoal(goalStoreRef(ctx), { status: "complete" });
			updateGoalUi(ctx, goal);
			return toolText(formatGoalToolResponse(goal, true));
		},
	});

	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Read the current persistent thread goal and usage accounting.",
		promptSnippet: "Read the current persistent goal before continuing or auditing long-running work.",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const goal = await readGoal(goalStoreRef(ctx));
			updateGoalUi(ctx, goal);
			return toolText(formatGoalToolResponse(goal, false));
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
							goal === null ? `${GOAL_USAGE}\n${GOAL_USAGE_HINT}` : formatGoalForTool(goal),
							goal ? "info" : "warning",
						);
						return;
					}
					case "setObjective": {
						await setGoalObjective(pi, ctx, command.objective);
						return;
					}
					case "setStatus": {
						const goal = await updateGoal(goalStoreRef(ctx), { status: command.status });
						updateGoalUi(ctx, goal);
						ctx.ui.notify(`Goal ${goalStatusLabel(goal.status)}\n${formatGoalForTool(goal)}`, "info");
						queueGoalContinuation(pi, ctx, goal);
						return;
					}
					case "clear": {
						const cleared = await clearGoal(goalStoreRef(ctx));
						updateGoalUi(ctx, null);
						ctx.ui.notify(cleared ? "Goal cleared." : "No goal was set.", cleared ? "info" : "warning");
						return;
					}
				}
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const goal = await readGoal(goalStoreRef(ctx));
		updateGoalUi(ctx, goal);
		if (goal?.status === "active" && ctx.isIdle() && !ctx.hasPendingMessages()) {
			pi.sendUserMessage(buildContinuationPrompt(goal), { deliverAs: "followUp" });
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const goal = await readGoal(goalStoreRef(ctx));
		if (!goal || goal.status !== "active") return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${buildGoalSystemPrompt(goal)}` };
	});

	pi.on("agent_start", () => {
		agentStartedAt = Date.now();
	});

	pi.on("agent_end", async (event, ctx) => {
		const startedAt = agentStartedAt;
		agentStartedAt = null;
		const elapsedSeconds = startedAt === null ? 0 : Math.max(0, Math.round((Date.now() - startedAt) / 1000));
		const goal = await accountGoalUsage(goalStoreRef(ctx), collectAssistantUsage(event.messages), elapsedSeconds);
		updateGoalUi(ctx, goal);
		if (goal?.status === "budgetLimited" && !ctx.hasPendingMessages()) {
			pi.sendUserMessage(buildBudgetLimitedPrompt(goal), { deliverAs: "followUp" });
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await refreshUi(ctx);
		updateGoalUi(ctx, null);
	});
}

async function setGoalObjective(pi: ExtensionAPI, ctx: ExtensionContext, objective: string): Promise<void> {
	const ref = goalStoreRef(ctx);
	const current = await readGoal(ref);
	if (current !== null && ctx.hasUI) {
		const shouldReplace = await ctx.ui.confirm("Replace goal?", `New objective: ${objective}`);
		if (!shouldReplace) return;
	}

	const goal = current === null ? await createGoal(ref, objective) : await updateGoal(ref, { objective });
	updateGoalUi(ctx, goal);
	ctx.ui.notify(`Goal ${goalStatusLabel(goal.status)}\n${formatGoalForTool(goal)}`, "info");
	queueGoalContinuation(pi, ctx, goal);
}

function queueGoalContinuation(pi: ExtensionAPI, ctx: ExtensionContext, goal: Goal): void {
	if (goal.status === "active" && ctx.isIdle() && !ctx.hasPendingMessages()) {
		pi.sendUserMessage(buildContinuationPrompt(goal), { deliverAs: "followUp" });
	}
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

function toolText(text: string, isError = false): GoalToolResult {
	return { content: [{ type: "text" as const, text }], details: {}, isError };
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
