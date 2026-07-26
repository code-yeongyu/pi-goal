import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	GoalAlreadyExistsError,
	GoalNotFoundError,
	InvalidGoalStoreError,
	UnsupportedGoalStoreVersionError,
} from "./errors.js";
import { transitionGoalStatus } from "./transitions.js";
import {
	type Goal,
	type GoalAccountingMode,
	type GoalFile,
	type GoalStatus,
	type GoalStoreRef,
	type GoalUpdate,
	type GoalUpdateSource,
	isRecord,
	type TokenUsageSnapshot,
} from "./types.js";
import { resolveTokenBudget, validateObjective } from "./validation.js";

const STORE_VERSION = 1;

export function goalFilePath(ref: GoalStoreRef): string {
	return join(ref.baseDir, `${encodedThreadId(ref)}.json`);
}

export function goalHistoryFilePath(ref: GoalStoreRef): string {
	return join(ref.baseDir, `${encodedThreadId(ref)}.history.jsonl`);
}

export function objectiveFullTextFileName(ref: GoalStoreRef): string {
	return `${encodedThreadId(ref)}.objective-full.txt`;
}

export function objectiveFullTextFilePath(ref: GoalStoreRef): string {
	return join(ref.baseDir, objectiveFullTextFileName(ref));
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

export async function createGoal(ref: GoalStoreRef, objective: string): Promise<Goal> {
	const validatedObjective = validateObjective(objective, objectiveFullTextFileName(ref));
	const current = await readGoal(ref);
	if (current !== null && current.status !== "complete") {
		throw new GoalAlreadyExistsError("cannot create a new goal because this thread already has a goal");
	}
	if (validatedObjective.truncated) await writeFullObjectiveText(ref, objective);
	if (current?.status === "complete") await archiveGoal(ref, current);
	const now = nowSeconds();
	const goal: Goal = {
		id: randomUUID(),
		threadId: ref.threadId,
		objective: validatedObjective.objective,
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: now,
		updatedAt: now,
		lastStartedAt: now,
	};
	await writeGoal(ref, goal);
	return goal;
}

export async function updateGoal(
	ref: GoalStoreRef,
	update: GoalUpdate,
	source: GoalUpdateSource = "model",
): Promise<Goal> {
	const current = await readGoal(ref);
	if (!current) throw new GoalNotFoundError("cannot update goal: no goal exists");

	const validatedObjective =
		update.objective === undefined ? undefined : validateObjective(update.objective, objectiveFullTextFileName(ref));
	const objective = validatedObjective?.objective ?? current.objective;
	const tokenBudget = resolveTokenBudget(current.tokenBudget, update.tokenBudget);
	const now = nextUpdatedAt(current.updatedAt);
	const hasObjectiveUpdate = update.objective !== undefined;
	const replacesGoal = hasObjectiveUpdate && (objective !== current.objective || current.status === "complete");
	const requestedStatus = update.status ?? (hasObjectiveUpdate ? "active" : undefined);

	if (replacesGoal) {
		const status = requestedStatus ?? "active";
		if (status === "blocked") throw new Error("objective replacement cannot create a blocked goal");
		const next: Goal = {
			id: randomUUID(),
			threadId: ref.threadId,
			objective,
			status,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: now,
			updatedAt: now,
			...(tokenBudget === undefined ? {} : { tokenBudget }),
		};
		if (status === "active") next.lastStartedAt = now;
		if (status === "complete") next.completedAt = now;
		if (validatedObjective?.truncated) await writeFullObjectiveText(ref, update.objective ?? "");
		await writeGoal(ref, next);
		return next;
	}

	const status = requestedStatus ?? current.status;
	const next = transitionGoalStatus({ ...current, objective }, status, source, update.reason, now);
	if (tokenBudget === undefined) {
		delete next.tokenBudget;
	} else {
		next.tokenBudget = tokenBudget;
	}
	if (validatedObjective?.truncated) await writeFullObjectiveText(ref, update.objective ?? "");
	await writeGoal(ref, next);
	return next;
}

export async function archiveGoal(ref: GoalStoreRef, goal: Goal): Promise<void> {
	const filePath = goalHistoryFilePath(ref);
	await mkdir(dirname(filePath), { recursive: true });
	await appendFile(filePath, `${JSON.stringify(goal)}\n`, "utf8");
}

async function writeFullObjectiveText(ref: GoalStoreRef, objective: string): Promise<void> {
	const filePath = objectiveFullTextFilePath(ref);
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, objective, "utf8");
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
	if (!goal) return goal;
	if (expectedGoalId !== undefined && goal.id !== expectedGoalId) return goal;
	if (!canAccountGoalUsage(goal, mode)) return goal;

	const now = nextUpdatedAt(goal.updatedAt);
	const next: Goal = {
		...goal,
		tokensUsed: goal.tokensUsed + goalTokenDeltaForUsage(usage),
		timeUsedSeconds: goal.timeUsedSeconds + Math.max(0, Math.trunc(elapsedSeconds)),
		updatedAt: now,
	};
	await writeGoal(ref, next);
	return next;
}

function canAccountGoalUsage(goal: Goal, mode: GoalAccountingMode): boolean {
	switch (mode) {
		case "active":
			return goal.status === "active";
		case "activeOrBlocked":
			return goal.status === "active" || goal.status === "blocked";
		case "activeOrComplete":
			return goal.status === "active" || goal.status === "complete";
	}
}

function goalTokenDeltaForUsage(usage: TokenUsageSnapshot): number {
	return Math.max(0, usage.input) + Math.max(0, usage.output);
}

function parseGoalFile(raw: string): GoalFile {
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed)) throw new InvalidGoalStoreError("goal store must be a JSON object");
	if (parsed["version"] !== STORE_VERSION)
		throw new UnsupportedGoalStoreVersionError("unsupported goal store version");
	const goal = parsed["goal"];
	if (goal !== null && !isGoal(goal)) throw new InvalidGoalStoreError("goal store contains an invalid goal");
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

function isGoal(value: unknown): value is Goal {
	if (!isRecord(value) || !isGoalStatus(value["status"])) return false;
	return (
		typeof value["id"] === "string" &&
		typeof value["threadId"] === "string" &&
		typeof value["objective"] === "string" &&
		(value["tokenBudget"] === undefined || isNonNegativeSafeInteger(value["tokenBudget"])) &&
		hasValidBlockedFields(value, value["status"]) &&
		isNonNegativeSafeInteger(value["tokensUsed"]) &&
		isNonNegativeSafeInteger(value["timeUsedSeconds"]) &&
		isNonNegativeSafeInteger(value["createdAt"]) &&
		isNonNegativeSafeInteger(value["updatedAt"]) &&
		(value["lastStartedAt"] === undefined || isNonNegativeSafeInteger(value["lastStartedAt"])) &&
		(value["completedAt"] === undefined || isNonNegativeSafeInteger(value["completedAt"]))
	);
}

function hasValidBlockedFields(value: Record<string, unknown>, status: GoalStatus): boolean {
	if (status === "blocked") {
		return (
			typeof value["blockedReason"] === "string" &&
			value["blockedReason"].trim().length > 0 &&
			isNonNegativeSafeInteger(value["blockedAt"])
		);
	}
	return value["blockedReason"] === undefined && value["blockedAt"] === undefined;
}

function isGoalStatus(value: unknown): value is GoalStatus {
	return value === "active" || value === "paused" || value === "blocked" || value === "complete";
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return isSafeInteger(value) && value >= 0;
}

function isSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value);
}

function encodedThreadId(ref: GoalStoreRef): string {
	return encodeURIComponent(ref.threadId);
}

function nextUpdatedAt(previousUpdatedAt: number): number {
	return Math.max(nowSeconds(), previousUpdatedAt + 1);
}

function nowSeconds(): number {
	return Math.trunc(Date.now() / 1000);
}
