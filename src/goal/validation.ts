import { GOAL_STATUS_VALUES, type GoalStatus } from "./types.js";

const MAX_OBJECTIVE_LENGTH = 20_000;

export function validateObjective(value: string): string {
	const objective = value.trim();
	if (objective.length === 0) throw new Error("objective must not be empty");
	if (objective.length > MAX_OBJECTIVE_LENGTH) {
		throw new Error(`objective must be at most ${MAX_OBJECTIVE_LENGTH} characters`);
	}
	return objective;
}

export function validateTokenBudget(value: number | null | undefined): number | null | undefined {
	if (value === undefined || value === null) return value;
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error("tokenBudget must be a positive safe integer");
	return value;
}

export function parseGoalStatus(value: string): GoalStatus {
	const status = GOAL_STATUS_VALUES.find((candidate) => candidate === value);
	if (!status) throw new Error(`status must be one of: ${GOAL_STATUS_VALUES.join(", ")}`);
	return status;
}
