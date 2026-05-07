import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { formatGoalElapsedSeconds, formatTokensCompact, goalStatusLabel } from "./format.js";
import type { Goal } from "./types.js";

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
	const tokenText =
		goal.tokenBudget === undefined
			? formatTokensCompact(goal.tokensUsed)
			: `${formatTokensCompact(goal.tokensUsed)}/${formatTokensCompact(goal.tokenBudget)}`;
	const statusColor = goal.status === "budget_limited" ? "warning" : goal.status === "complete" ? "success" : "accent";
	ctx.ui.setStatus(STATUS_KEY, theme.fg(statusColor, ` Goal ${goalStatusLabel(goal.status)} · ${tokenText}`));
	ctx.ui.setWidget(
		WIDGET_KEY,
		[
			theme.fg("accent", theme.bold("Goal")),
			theme.fg("muted", goal.objective),
			theme.fg("dim", `Status: ${goalStatusLabel(goal.status)}`),
			theme.fg("dim", `Time: ${formatGoalElapsedSeconds(goal.timeUsedSeconds)}`),
			theme.fg("dim", `Tokens: ${tokenText}`),
		],
		{ placement: "belowEditor" },
	);
}
