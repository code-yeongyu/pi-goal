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
		tokenBudget,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: now,
		updatedAt: now,
		lastStartedAt: now,
	};
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
	const next: Goal = replacesObjective
		? {
				id: randomUUID(),
				objective,
				status,
				tokenBudget: tokenBudget === null ? undefined : (tokenBudget ?? current.tokenBudget),
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
				lastStartedAt: status === "active" ? now : undefined,
			}
		: {
				...current,
				objective,
				status,
				updatedAt: now,
				tokenBudget: tokenBudget === null ? undefined : (tokenBudget ?? current.tokenBudget),
				lastStartedAt: status === "active" && current.status !== "active" ? now : current.lastStartedAt,
				completedAt: status === "complete" ? (current.completedAt ?? now) : undefined,
			};

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
	if (next.status === "budget_limited") next.lastStartedAt = undefined;
	await writeGoal(cwd, next);
	return next;
}

function parseGoalFile(raw: string): GoalFile {
	const parsed = JSON.parse(raw) as Partial<GoalFile>;
	if (parsed.version !== STORE_VERSION) throw new Error("unsupported goal store version");
	return {
		version: STORE_VERSION,
		goal: parsed.goal ?? null,
	};
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
