import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Goal, GoalAccountingMode, GoalFile, GoalStoreRef, GoalUpdate, TokenUsageSnapshot } from "./types.js";
import { validateObjective, validateTokenBudget } from "./validation.js";

const STORE_VERSION = 1;

export function goalFilePath(ref: GoalStoreRef): string {
	return join(ref.baseDir, `${encodeURIComponent(ref.threadId)}.json`);
}

export async function readGoal(ref: GoalStoreRef): Promise<Goal | null> {
	const filePath = goalFilePath(ref);
	try {
		const raw = await readFile(filePath, "utf8");
		return parseGoalFile(raw).goal;
	} catch (error) {
		if (isMissingFile(error)) return null;
		throw error;
	}
}

export async function writeGoal(ref: GoalStoreRef, goal: Goal | null): Promise<void> {
	const filePath = goalFilePath(ref);
	await mkdir(dirname(filePath), { recursive: true });
	const file: GoalFile = { version: STORE_VERSION, goal };
	await writeFile(filePath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

export async function createGoal(ref: GoalStoreRef, objective: string, tokenBudget?: number): Promise<Goal> {
	const normalizedObjective = validateObjective(objective);
	validateTokenBudget(tokenBudget);
	const now = nowSeconds();
	const goal: Goal = {
		id: randomUUID(),
		threadId: ref.threadId,
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
	await writeGoal(ref, goal);
	return goal;
}

export async function updateGoal(ref: GoalStoreRef, update: GoalUpdate): Promise<Goal> {
	const current = await readGoal(ref);
	if (!current) throw new Error("cannot update goal: no goal exists");

	const tokenBudget = validateTokenBudget(update.tokenBudget);
	const objective = update.objective === undefined ? current.objective : validateObjective(update.objective);
	const now = nowSeconds();
	const hasObjectiveUpdate = update.objective !== undefined;
	const replacesGoal = hasObjectiveUpdate && (objective !== current.objective || current.status === "complete");
	const status = update.status ?? (hasObjectiveUpdate ? "active" : current.status);

	if (replacesGoal) {
		const next: Goal = {
			id: randomUUID(),
			threadId: ref.threadId,
			objective,
			status,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: now,
			updatedAt: now,
		};
		const replacementBudget = tokenBudget === null ? undefined : tokenBudget;
		if (replacementBudget !== undefined) next.tokenBudget = replacementBudget;
		if (status === "active") next.lastStartedAt = now;
		await writeGoal(ref, next);
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

	await writeGoal(ref, next);
	return next;
}

export async function clearGoal(ref: GoalStoreRef): Promise<boolean> {
	const hadGoal = (await readGoal(ref)) !== null;
	await writeGoal(ref, null);
	return hadGoal;
}

export async function accountGoalUsage(
	ref: GoalStoreRef,
	usage: TokenUsageSnapshot,
	elapsedSeconds: number,
	mode: GoalAccountingMode = "active",
	expectedGoalId?: string,
): Promise<Goal | null> {
	const goal = await readGoal(ref);
	if (!goal || (expectedGoalId !== undefined && goal.id !== expectedGoalId) || !canAccountGoalUsage(goal, mode)) {
		return goal;
	}

	const tokensUsed = goal.tokensUsed + goalTokenDeltaForUsage(usage);
	const now = nowSeconds();
	const next: Goal = {
		...goal,
		tokensUsed,
		timeUsedSeconds: goal.timeUsedSeconds + Math.max(0, Math.trunc(elapsedSeconds)),
		updatedAt: now,
		status:
			goal.status === "active" && goal.tokenBudget !== undefined && tokensUsed >= goal.tokenBudget
				? "budgetLimited"
				: goal.status,
	};
	if (next.status === "budgetLimited") delete next.lastStartedAt;
	await writeGoal(ref, next);
	return next;
}

function canAccountGoalUsage(goal: Goal, mode: GoalAccountingMode): boolean {
	switch (mode) {
		case "active":
			return goal.status === "active";
		case "activeOrComplete":
			return goal.status === "active" || goal.status === "complete";
	}
}

function goalTokenDeltaForUsage(usage: TokenUsageSnapshot): number {
	const nonCachedInput = Math.max(0, usage.input - usage.cacheRead);
	return nonCachedInput + Math.max(0, usage.output);
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
		typeof value["threadId"] === "string" &&
		typeof value["objective"] === "string" &&
		isGoalStatus(value["status"]) &&
		(value["tokenBudget"] === undefined || isPositiveSafeInteger(value["tokenBudget"])) &&
		isNonNegativeSafeInteger(value["tokensUsed"]) &&
		isNonNegativeSafeInteger(value["timeUsedSeconds"]) &&
		isNonNegativeSafeInteger(value["createdAt"]) &&
		isNonNegativeSafeInteger(value["updatedAt"]) &&
		(value["lastStartedAt"] === undefined || isNonNegativeSafeInteger(value["lastStartedAt"])) &&
		(value["completedAt"] === undefined || isNonNegativeSafeInteger(value["completedAt"]))
	);
}

function isGoalStatus(value: unknown): value is Goal["status"] {
	return value === "active" || value === "paused" || value === "budgetLimited" || value === "complete";
}

function isPositiveSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function nowSeconds(): number {
	return Math.trunc(Date.now() / 1000);
}
