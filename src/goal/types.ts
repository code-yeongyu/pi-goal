export const GOAL_STATUS_VALUES = ["active", "paused", "budget_limited", "complete"] as const;

export type GoalStatus = (typeof GOAL_STATUS_VALUES)[number];

export interface Goal {
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: string;
	updatedAt: string;
	lastStartedAt?: string;
	completedAt?: string;
}

export interface GoalFile {
	version: 1;
	goal: Goal | null;
}

export interface TokenUsageSnapshot {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
}

export interface GoalUpdate {
	objective?: string;
	status?: GoalStatus;
	tokenBudget?: number | null;
}
