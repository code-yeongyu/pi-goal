import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatGoalElapsedSeconds } from "./format.js";
import type { Goal } from "./types.js";

export const STATUS_KEY = "goal";

export function updateGoalUi(ctx: ExtensionContext, goal: Goal | null): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, goal === null ? undefined : goalStatusText(goal));
}

export function goalStatusText(goal: Goal): string {
	switch (goal.status) {
		case "active":
			return goal.timeUsedSeconds > 0
				? `Pursuing goal (${formatGoalElapsedSeconds(goal.timeUsedSeconds)})`
				: "Pursuing goal";
		case "paused":
			return "Goal paused (/goal resume)";
		case "complete":
			return "Goal achieved";
	}
}
