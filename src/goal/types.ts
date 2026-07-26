export const GOAL_STATUS_VALUES = ["active", "paused", "complete"] as const;
export const MODEL_SETTABLE_GOAL_STATUS_VALUES = ["complete", "blocked"] as const;

export type GoalStatus = (typeof GOAL_STATUS_VALUES)[number];
export type ModelSettableGoalStatus = (typeof MODEL_SETTABLE_GOAL_STATUS_VALUES)[number];

export type GoalStoreRef = {
	baseDir: string;
	threadId: string;
};

export type GoalAccountingMode = "active" | "activeOrComplete";

export type Goal = {
	id: string;
	threadId: string;
	objective: string;
	status: GoalStatus;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
	lastStartedAt?: number;
	completedAt?: number;
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
};

export type GoalToolSnapshot = {
	threadId: string;
	objective: string;
	status: GoalStatus;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
};

export type GoalToolResponse = {
	goal: GoalToolSnapshot | null;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
