import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { parseGoalCommand } from "./command.js";
import { formatGoalForTool, goalStatusLabel } from "./format.js";
import { clearGoal, createGoal, readGoal, updateGoal } from "./store.js";
import type { Goal, GoalAccountingMode, GoalStoreRef } from "./types.js";
import { updateGoalUi } from "./ui.js";

const GOAL_USAGE = "Usage: /goal <objective>";
const GOAL_EMPTY_HINT = "No goal is currently set.";
const REPLACE_GOAL_CHOICE = "Replace current goal";
const CANCEL_REPLACE_GOAL_CHOICE = "Cancel";

export type GoalCommandRegistrationDeps = {
	goalStoreRef(ctx: ExtensionContext): GoalStoreRef;
	beginAgentGoalAccounting(goal: Goal): void;
	stopAgentGoalAccounting(goalId: string): void;
	clearAgentGoalAccounting(): void;
	accountCurrentAgentTurn(ctx: ExtensionContext, mode: GoalAccountingMode): Promise<Goal | null>;
	queueGoalContinuation(ctx: ExtensionContext, goal: Goal): void;
};

export function registerGoalCommand(pi: ExtensionAPI, deps: GoalCommandRegistrationDeps): void {
	pi.registerCommand("goal", {
		description: "Set, inspect, pause, resume, or clear the persistent goal",
		handler: async (rawArgs, ctx) => {
			const command = parseGoalCommand(rawArgs);
			try {
				switch (command.kind) {
					case "show": {
						const goal = await readGoal(deps.goalStoreRef(ctx));
						updateGoalUi(ctx, goal);
						ctx.ui.notify(
							goal === null ? `${GOAL_USAGE}\n${GOAL_EMPTY_HINT}` : formatGoalForTool(goal),
							goal ? "info" : "warning",
						);
						return;
					}
					case "setObjective": {
						await setGoalObjective(ctx, command.objective, deps);
						return;
					}
					case "setStatus": {
						if (command.status === "paused") {
							await deps.accountCurrentAgentTurn(ctx, "active");
						}
						const goal = await updateGoal(deps.goalStoreRef(ctx), { status: command.status }, "user");
						if (goal.status === "active") {
							deps.beginAgentGoalAccounting(goal);
						} else {
							deps.stopAgentGoalAccounting(goal.id);
						}
						updateGoalUi(ctx, goal);
						ctx.ui.notify(`Goal ${goalStatusLabel(goal.status)}\n${formatGoalForTool(goal)}`, "info");
						deps.queueGoalContinuation(ctx, goal);
						return;
					}
					case "clear": {
						await deps.accountCurrentAgentTurn(ctx, "active");
						const cleared = await clearGoal(deps.goalStoreRef(ctx));
						deps.clearAgentGoalAccounting();
						updateGoalUi(ctx, null);
						ctx.ui.notify(
							cleared ? "Goal cleared" : "No goal to clear\nThis thread does not currently have a goal.",
							cleared ? "info" : "warning",
						);
						return;
					}
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

async function setGoalObjective(
	ctx: ExtensionContext,
	objective: string,
	deps: GoalCommandRegistrationDeps,
): Promise<void> {
	const ref = deps.goalStoreRef(ctx);
	const current = await readGoal(ref);
	if (current !== null && !(await confirmReplaceGoal(ctx, objective))) return;

	if (current?.status === "active") {
		await deps.accountCurrentAgentTurn(ctx, "active");
	}
	const goal = current === null ? await createGoal(ref, objective) : await updateGoal(ref, { objective }, "user");
	if (goal.status === "active") deps.beginAgentGoalAccounting(goal);
	updateGoalUi(ctx, goal);
	ctx.ui.notify(`Goal ${goalStatusLabel(goal.status)}\n${formatGoalForTool(goal)}`, "info");
	deps.queueGoalContinuation(ctx, goal);
}

async function confirmReplaceGoal(ctx: ExtensionContext, objective: string): Promise<boolean> {
	if (!ctx.hasUI) return true;
	const choice = await ctx.ui.select(`Replace goal?\nNew objective: ${objective}`, [
		REPLACE_GOAL_CHOICE,
		CANCEL_REPLACE_GOAL_CHOICE,
	]);
	return choice === REPLACE_GOAL_CHOICE;
}
