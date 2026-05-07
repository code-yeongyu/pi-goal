export const GOAL_STATUS_VALUES = ["active", "paused", "budget_limited", "complete"] as const;
export const COMPLETABLE_GOAL_STATUS_VALUES = ["complete"] as const;

export type GoalStatus = (typeof GOAL_STATUS_VALUES)[number];
export type CompletableGoalStatus = (typeof COMPLETABLE_GOAL_STATUS_VALUES)[number];

export type Goal = {
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
};

export type GoalFile = {
	version: 1;
	goal: Goal | null;
};

export type TokenUsageSnapshot = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
};

export type GoalUpdate = {
	objective?: string;
	status?: GoalStatus;
	tokenBudget?: number | null;
};

export type GoalToolSnapshot = {
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget: number | null;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
};

export type GoalToolResponse = {
	goal: GoalToolSnapshot | null;
	remainingTokens: number | null;
	completionBudgetReport: string | null;
};
