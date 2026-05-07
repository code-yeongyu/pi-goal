import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Goal, GoalFile, GoalUpdate, TokenUsageSnapshot } from "./types.js";
import { validateObjective, validateTokenBudget } from "./validation.js";

const STORE_VERSION = 1;

export function goalFilePath(cwd: string): string {
	return join(cwd, ".pi", "goal.json");
}

export async function readGoal(cwd: string): Promise<Goal | null> {
	const filePath = goalFilePath(cwd);
	try {
		const raw = await readFile(filePath, "utf8");
		return parseGoalFile(raw).goal;
	} catch (error) {
		if (isMissingFile(error)) return null;
		throw error;
	}
}

export async function writeGoal(cwd: string, goal: Goal | null): Promise<void> {
	const filePath = goalFilePath(cwd);
	await mkdir(dirname(filePath), { recursive: true });
	const file: GoalFile = { version: STORE_VERSION, goal };
	await writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

export async function createGoal(cwd: string, objective: string, tokenBudget?: number): Promise<Goal> {
	const normalizedObjective = validateObjective(objective);
	validateTokenBudget(tokenBudget);
	const now = new Date().toISOString();
	const goal: Goal = {
		id: randomUUID(),
		objective: normalizedObjective,
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: now,
		updatedAt: now,
		lastStartedAt: now,
	};
	if (tokenBudget !== undefined) {
		goal.tokenBudget = tokenBudget;
	}
	await writeGoal(cwd, goal);
	return goal;
}

export async function updateGoal(cwd: string, update: GoalUpdate): Promise<Goal> {
	const current = await readGoal(cwd);
	if (!current) throw new Error("cannot update goal: no goal exists");

	const tokenBudget = validateTokenBudget(update.tokenBudget);
	const objective = update.objective === undefined ? current.objective : validateObjective(update.objective);
	const now = new Date().toISOString();
	const replacesObjective = objective !== current.objective;
	const status = update.status ?? (replacesObjective ? "active" : current.status);

	if (replacesObjective) {
		const next: Goal = {
			id: randomUUID(),
			objective,
			status,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: now,
			updatedAt: now,
		};
		const replacementBudget = tokenBudget === null ? undefined : (tokenBudget ?? current.tokenBudget);
		if (replacementBudget !== undefined) next.tokenBudget = replacementBudget;
		if (status === "active") next.lastStartedAt = now;
		await writeGoal(cwd, next);
		return next;
	}

	const next: Goal = {
		...current,
		objective,
		status,
		updatedAt: now,
	};

	if (tokenBudget === null) {
		delete next.tokenBudget;
	} else if (tokenBudget !== undefined) {
		next.tokenBudget = tokenBudget;
	}

	if (status === "active" && current.status !== "active") {
		next.lastStartedAt = now;
	} else if (status !== "active") {
		delete next.lastStartedAt;
	}

	if (status === "complete") {
		next.completedAt = current.completedAt ?? now;
	} else {
		delete next.completedAt;
	}

	await writeGoal(cwd, next);
	return next;
}

export async function clearGoal(cwd: string): Promise<boolean> {
	const hadGoal = (await readGoal(cwd)) !== null;
	await writeGoal(cwd, null);
	return hadGoal;
}

export async function accountGoalUsage(
	cwd: string,
	usage: TokenUsageSnapshot,
	elapsedSeconds: number,
): Promise<Goal | null> {
	const goal = await readGoal(cwd);
	if (!goal || goal.status !== "active") return goal;

	const tokensUsed = goal.tokensUsed + usage.totalTokens;
	const now = new Date().toISOString();
	const next: Goal = {
		...goal,
		tokensUsed,
		timeUsedSeconds: goal.timeUsedSeconds + Math.max(0, Math.trunc(elapsedSeconds)),
		updatedAt: now,
		status: goal.tokenBudget !== undefined && tokensUsed >= goal.tokenBudget ? "budget_limited" : goal.status,
	};
	if (next.status === "budget_limited") delete next.lastStartedAt;
	await writeGoal(cwd, next);
	return next;
}

function parseGoalFile(raw: string): GoalFile {
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed)) throw new Error("goal store must be a JSON object");
	if (parsed["version"] !== STORE_VERSION) throw new Error("unsupported goal store version");
	const goal = parsed["goal"];
	if (goal !== null && !isGoal(goal)) throw new Error("goal store contains an invalid goal");
	return {
		version: STORE_VERSION,
		goal,
	};
}

function isMissingFile(error: unknown): boolean {
	return isErrorWithCode(error) && error.code === "ENOENT";
}

function isErrorWithCode(error: unknown): error is Error & { code: string } {
	return error instanceof Error && "code" in error && typeof error.code === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isGoal(value: unknown): value is Goal {
	if (!isRecord(value)) return false;
	return (
		typeof value["id"] === "string" &&
		typeof value["objective"] === "string" &&
		isGoalStatus(value["status"]) &&
		(value["tokenBudget"] === undefined || isPositiveSafeInteger(value["tokenBudget"])) &&
		isNonNegativeSafeInteger(value["tokensUsed"]) &&
		isNonNegativeSafeInteger(value["timeUsedSeconds"]) &&
		typeof value["createdAt"] === "string" &&
		typeof value["updatedAt"] === "string" &&
		(value["lastStartedAt"] === undefined || typeof value["lastStartedAt"] === "string") &&
		(value["completedAt"] === undefined || typeof value["completedAt"] === "string")
	);
}

function isGoalStatus(value: unknown): value is Goal["status"] {
	return value === "active" || value === "paused" || value === "budget_limited" || value === "complete";
}

function isPositiveSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}
