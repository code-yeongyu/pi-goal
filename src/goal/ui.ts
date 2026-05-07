import type { ExtensionContext, ThemeColor } from "@mariozechner/pi-coding-agent";

import { formatGoalElapsedSeconds, formatTokensCompact, goalStatusLabel } from "./format.js";
import type { Goal, GoalStatus } from "./types.js";

export const STATUS_KEY = "goal";
export const WIDGET_KEY = "goal";

export function updateGoalUi(ctx: ExtensionContext, goal: Goal | null): void {
	if (!ctx.hasUI) return;
	if (!goal) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		return;
	}

	const { theme } = ctx.ui;
	const usageText = goalStatusUsage(goal);
	const statusColor = goalStatusColor(goal.status);
	ctx.ui.setStatus(
		STATUS_KEY,
		theme.fg(
			statusColor,
			usageText === null
				? ` Goal ${goalStatusLabel(goal.status)}`
				: ` Goal ${goalStatusLabel(goal.status)} · ${usageText}`,
		),
	);
	ctx.ui.setWidget(
		WIDGET_KEY,
		[
			theme.fg("accent", theme.bold("Goal")),
			theme.fg("muted", goal.objective),
			theme.fg("dim", `Status: ${goalStatusLabel(goal.status)}`),
			theme.fg("dim", `Time: ${formatGoalElapsedSeconds(goal.timeUsedSeconds)}`),
			theme.fg("dim", `Tokens: ${tokenUsage(goal)}`),
		],
		{ placement: "belowEditor" },
	);
}

function goalStatusUsage(goal: Goal): string | null {
	switch (goal.status) {
		case "active":
			return goal.tokenBudget === undefined
				? formatGoalElapsedSeconds(goal.timeUsedSeconds)
				: `${formatTokensCompact(goal.tokensUsed)} / ${formatTokensCompact(goal.tokenBudget)}`;
		case "paused":
			return null;
		case "budget_limited":
			return goal.tokenBudget === undefined
				? null
				: `${formatTokensCompact(goal.tokensUsed)} / ${formatTokensCompact(goal.tokenBudget)} tokens`;
		case "complete":
			return goal.tokenBudget === undefined
				? formatGoalElapsedSeconds(goal.timeUsedSeconds)
				: `${formatTokensCompact(goal.tokensUsed)} tokens`;
	}
}

function goalStatusColor(status: GoalStatus): ThemeColor {
	switch (status) {
		case "active":
			return "accent";
		case "paused":
			return "muted";
		case "budget_limited":
			return "warning";
		case "complete":
			return "success";
	}
}

function tokenUsage(goal: Goal): string {
	if (goal.tokenBudget === undefined) return formatTokensCompact(goal.tokensUsed);
	return `${formatTokensCompact(goal.tokensUsed)} / ${formatTokensCompact(goal.tokenBudget)}`;
}
