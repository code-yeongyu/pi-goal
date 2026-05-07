import type { Goal, GoalStatus } from "./types.js";

export function formatGoalElapsedSeconds(value: number): string {
	const seconds = Math.max(0, Math.trunc(value));
	if (seconds < 60) return `${seconds}s`;

	const minutes = Math.trunc(seconds / 60);
	if (minutes < 60) return `${minutes}m`;

	const hours = Math.trunc(minutes / 60);
	const remainingMinutes = minutes % 60;
	if (hours >= 24) {
		const days = Math.trunc(hours / 24);
		const remainingHours = hours % 24;
		return `${days}d ${remainingHours}h ${remainingMinutes}m`;
	}

	if (remainingMinutes === 0) return `${hours}h`;
	return `${hours}h ${remainingMinutes}m`;
}

export function formatTokensCompact(value: number): string {
	const abs = Math.abs(value);
	if (abs >= 1_000_000) return `${formatOneDecimal(value / 1_000_000)}M`;
	if (abs >= 1_000) return `${formatOneDecimal(value / 1_000)}K`;
	return `${Math.trunc(value)}`;
}

export function goalStatusLabel(status: GoalStatus): string {
	switch (status) {
		case "active":
			return "active";
		case "paused":
			return "paused";
		case "budget_limited":
			return "limited by budget";
		case "complete":
			return "complete";
	}
}

export function goalUsageSummary(goal: Goal): string {
	const parts = [`Objective: ${goal.objective}`];
	if (goal.timeUsedSeconds > 0) parts.push(`Time: ${formatGoalElapsedSeconds(goal.timeUsedSeconds)}.`);
	if (goal.tokenBudget !== undefined) {
		parts.push(`Tokens: ${formatTokensCompact(goal.tokensUsed)}/${formatTokensCompact(goal.tokenBudget)}.`);
	}
	return parts.join(" ");
}

export function formatGoalForTool(goal: Goal | null): string {
	if (!goal) return "No active goal is set.";
	const lines = [
		`Objective: ${goal.objective}`,
		`Status: ${goalStatusLabel(goal.status)}`,
		`Time used: ${formatGoalElapsedSeconds(goal.timeUsedSeconds)}`,
		`Tokens used: ${formatTokensCompact(goal.tokensUsed)}${goal.tokenBudget === undefined ? "" : `/${formatTokensCompact(goal.tokenBudget)}`}`,
	];
	if (goal.completedAt) lines.push(`Completed at: ${goal.completedAt}`);
	return lines.join("\n");
}

function formatOneDecimal(value: number): string {
	const rounded = value.toFixed(1);
	return rounded.endsWith(".0") ? rounded.slice(0, -2) : rounded;
}
