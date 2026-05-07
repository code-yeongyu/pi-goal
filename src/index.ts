import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import { formatGoalForTool } from "./goal/format.js";
import { buildBudgetLimitedPrompt, buildContinuationPrompt, buildGoalSystemPrompt } from "./goal/prompt.js";
import { accountGoalUsage, clearGoal, createGoal, readGoal, updateGoal } from "./goal/store.js";
import type { TokenUsageSnapshot } from "./goal/types.js";
import { GOAL_STATUS_VALUES } from "./goal/types.js";
import { updateGoalUi } from "./goal/ui.js";
import { parseGoalStatus } from "./goal/validation.js";

const HELP = `Goal commands:
/goal set <objective> [--token-budget N]
/goal status
/goal pause
/goal resume
/goal complete
/goal clear

Agent tools:
create_goal, update_goal, get_goal`;

export default function (pi: ExtensionAPI): void {
	let agentStartedAt: number | null = null;

	async function refreshUi(ctx: ExtensionContext): Promise<void> {
		updateGoalUi(ctx, await readGoal(ctx.cwd));
	}

	pi.registerTool({
		name: "create_goal",
		label: "Create Goal",
		description: "Create a persistent thread goal. Fails if a goal already exists.",
		promptSnippet: "Create a persistent goal when the user explicitly asks to track a long-running objective.",
		promptGuidelines: [
			"Use create_goal only when the user explicitly asks for goal tracking or a persistent long-running objective.",
			"Do not create goals for ordinary one-turn tasks.",
		],
		parameters: Type.Object({
			objective: Type.String({ description: "The concrete objective to pursue." }),
			tokenBudget: Type.Optional(Type.Number({ description: "Optional positive token budget." })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if ((await readGoal(ctx.cwd)) !== null) {
				return toolText("A goal already exists. Use update_goal or /goal clear first.", true);
			}
			const goal = await createGoal(ctx.cwd, params.objective, params.tokenBudget);
			updateGoalUi(ctx, goal);
			return toolText(`Created goal.\n${formatGoalForTool(goal)}`);
		},
	});

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description: "Update the persistent thread goal status, objective, or token budget.",
		promptSnippet: "Update a persistent goal when it is complete, paused, budget-limited, or needs a revised budget.",
		promptGuidelines: [
			"Only mark a goal complete after auditing the actual current state against the user's objective.",
			"Use status budget_limited when token budget, not task completion, is the reason to pause.",
		],
		parameters: Type.Object({
			objective: Type.Optional(Type.String({ description: "Replacement objective. Resets usage if changed." })),
			status: Type.Optional(
				Type.Union(
					GOAL_STATUS_VALUES.map((status) => Type.Literal(status)),
					{
						description: "New goal status.",
					},
				),
			),
			tokenBudget: Type.Optional(
				Type.Union([Type.Number(), Type.Null()], {
					description: "Positive token budget, or null to remove it.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const status = params.status === undefined ? undefined : parseGoalStatus(params.status);
			const goal = await updateGoal(ctx.cwd, {
				objective: params.objective,
				status,
				tokenBudget: params.tokenBudget,
			});
			updateGoalUi(ctx, goal);
			return toolText(`Updated goal.\n${formatGoalForTool(goal)}`);
		},
	});

	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Read the current persistent thread goal and usage accounting.",
		promptSnippet: "Read the current persistent goal before continuing or auditing long-running work.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const goal = await readGoal(ctx.cwd);
			updateGoalUi(ctx, goal);
			return toolText(formatGoalForTool(goal));
		},
	});

	pi.registerCommand("goal", {
		description: "Set, inspect, pause, resume, complete, or clear the persistent goal",
		handler: async (rawArgs, ctx) => {
			const [command, rest] = splitCommand(rawArgs.trim());
			try {
				switch (command) {
					case "":
					case "status": {
						const goal = await readGoal(ctx.cwd);
						updateGoalUi(ctx, goal);
						ctx.ui.notify(formatGoalForTool(goal), goal ? "info" : "warning");
						return;
					}
					case "set": {
						const parsed = parseSetArgs(rest);
						const goal = (await readGoal(ctx.cwd))
							? await updateGoal(ctx.cwd, { objective: parsed.objective, tokenBudget: parsed.tokenBudget })
							: await createGoal(ctx.cwd, parsed.objective, parsed.tokenBudget ?? undefined);
						updateGoalUi(ctx, goal);
						ctx.ui.notify(`Goal set.\n${formatGoalForTool(goal)}`, "info");
						return;
					}
					case "pause":
					case "resume":
					case "complete": {
						const status = command === "pause" ? "paused" : command === "resume" ? "active" : "complete";
						const goal = await updateGoal(ctx.cwd, { status });
						updateGoalUi(ctx, goal);
						ctx.ui.notify(
							`Goal ${status === "active" ? "resumed" : status}.\n${formatGoalForTool(goal)}`,
							"info",
						);
						return;
					}
					case "clear": {
						const cleared = await clearGoal(ctx.cwd);
						updateGoalUi(ctx, null);
						ctx.ui.notify(cleared ? "Goal cleared." : "No goal was set.", cleared ? "info" : "warning");
						return;
					}
					default:
						ctx.ui.notify(HELP, "info");
				}
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const goal = await readGoal(ctx.cwd);
		updateGoalUi(ctx, goal);
		if (goal?.status === "active" && ctx.isIdle() && !ctx.hasPendingMessages()) {
			pi.sendUserMessage(buildContinuationPrompt(goal), { deliverAs: "followUp" });
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const goal = await readGoal(ctx.cwd);
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
		const goal = await accountGoalUsage(ctx.cwd, collectAssistantUsage(event.messages), elapsedSeconds);
		updateGoalUi(ctx, goal);
		if (goal?.status === "budget_limited" && !ctx.hasPendingMessages()) {
			pi.sendUserMessage(buildBudgetLimitedPrompt(goal), { deliverAs: "followUp" });
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await refreshUi(ctx);
		updateGoalUi(ctx, null);
	});
}

function toolText(text: string, isError = false) {
	return { content: [{ type: "text" as const, text }], details: {}, isError };
}

function splitCommand(raw: string): [string, string] {
	const match = raw.match(/^(\S+)(?:\s+([\s\S]*))?$/);
	if (!match) return ["", ""];
	return [match[1] ?? "", match[2] ?? ""];
}

function parseSetArgs(raw: string): { objective: string; tokenBudget: number | null } {
	const tokenBudgetMatch = raw.match(/\s+--token-budget\s+(\d+)\s*$/);
	const objective = (tokenBudgetMatch ? raw.slice(0, tokenBudgetMatch.index) : raw).trim();
	const tokenBudget = tokenBudgetMatch ? Number.parseInt(tokenBudgetMatch[1] ?? "", 10) : null;
	return { objective, tokenBudget };
}

function collectAssistantUsage(messages: unknown[]): TokenUsageSnapshot {
	const usage: TokenUsageSnapshot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
	for (const message of messages) {
		if (!isAssistantMessage(message)) continue;
		usage.input += message.usage.input || 0;
		usage.output += message.usage.output || 0;
		usage.cacheRead += message.usage.cacheRead || 0;
		usage.cacheWrite += message.usage.cacheWrite || 0;
		usage.totalTokens += message.usage.totalTokens || 0;
	}
	return usage;
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	return (message as { role?: unknown }).role === "assistant";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
