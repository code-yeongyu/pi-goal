import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { accountGoalUsage, clearGoal, createGoal, goalFilePath, readGoal, updateGoal } from "../src/goal/store.js";

const tempDirs: string[] = [];

describe("goal store", () => {
	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("creates a persisted active goal", async () => {
		const cwd = await tempDir();
		const goal = await createGoal(cwd, "  Ship the extension  ", 10_000);

		expect(goal.objective).toBe("Ship the extension");
		expect(goal.status).toBe("active");
		expect(goal.tokenBudget).toBe(10_000);
		expect(await readGoal(cwd)).toMatchObject({ id: goal.id, objective: "Ship the extension" });
		expect(await readFile(goalFilePath(cwd), "utf8")).toContain('"version": 1');
	});

	it("replaces changed objectives and preserves usage for status updates", async () => {
		const cwd = await tempDir();
		const first = await createGoal(cwd, "Original");
		await accountGoalUsage(cwd, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 25 }, 70);

		const paused = await updateGoal(cwd, { status: "paused" });
		expect(paused.id).toBe(first.id);
		expect(paused.tokensUsed).toBe(25);
		expect(paused.timeUsedSeconds).toBe(70);

		const replaced = await updateGoal(cwd, { objective: "Replacement" });
		expect(replaced.id).not.toBe(first.id);
		expect(replaced.tokensUsed).toBe(0);
		expect(replaced.timeUsedSeconds).toBe(0);
		expect(replaced.status).toBe("active");
	});

	it("marks active goals budget_limited when accounting reaches budget", async () => {
		const cwd = await tempDir();
		await createGoal(cwd, "Budgeted", 50);

		const goal = await accountGoalUsage(
			cwd,
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 51 },
			4,
		);

		expect(goal).toMatchObject({ status: "budget_limited", tokensUsed: 51, timeUsedSeconds: 4 });
	});

	it("clears the store while preserving the versioned file", async () => {
		const cwd = await tempDir();
		await createGoal(cwd, "Temporary");

		expect(await clearGoal(cwd)).toBe(true);
		expect(await readGoal(cwd)).toBeNull();
	});
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-goal-"));
	tempDirs.push(dir);
	return dir;
}
