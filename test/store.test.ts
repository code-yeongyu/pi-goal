import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { accountGoalUsage, clearGoal, createGoal, goalFilePath, readGoal, updateGoal } from "../src/goal/store.js";
import type { GoalStoreRef } from "../src/goal/types.js";

const tempDirs: string[] = [];

describe("goal store", () => {
	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("creates a persisted active goal", async () => {
		const ref = await tempStore("thread-create");
		const goal = await createGoal(ref, "  Ship the extension  ", 10_000);

		expect(goal.threadId).toBe("thread-create");
		expect(goal.objective).toBe("Ship the extension");
		expect(goal.status).toBe("active");
		expect(goal.tokenBudget).toBe(10_000);
		expect(await readGoal(ref)).toMatchObject({ id: goal.id, objective: "Ship the extension" });
		expect(goalFilePath(ref)).toContain("extensions/pi-goal/thread-create.json");
		expect(goalFilePath(ref)).not.toContain(".pi");
		expect(await readFile(goalFilePath(ref), "utf8")).toContain('"version": 1');
	});

	it("replaces changed objectives and preserves usage for status updates", async () => {
		const ref = await tempStore();
		const first = await createGoal(ref, "Original");
		await accountGoalUsage(ref, { input: 23, output: 2, cacheRead: 0, cacheWrite: 4, totalTokens: 25 }, 70);

		const paused = await updateGoal(ref, { status: "paused" });
		expect(paused.id).toBe(first.id);
		expect(paused.tokensUsed).toBe(25);
		expect(paused.timeUsedSeconds).toBe(70);

		const replaced = await updateGoal(ref, { objective: "Replacement" });
		expect(replaced.id).not.toBe(first.id);
		expect(replaced.tokensUsed).toBe(0);
		expect(replaced.timeUsedSeconds).toBe(0);
		expect(replaced.status).toBe("active");
	});

	it("resumes a matching nonterminal goal when the objective is set again", async () => {
		const ref = await tempStore();
		const first = await createGoal(ref, "Same");
		const paused = await updateGoal(ref, { status: "paused" });

		const resumed = await updateGoal(ref, { objective: "Same" });

		expect(paused.id).toBe(first.id);
		expect(resumed.id).toBe(first.id);
		expect(resumed.status).toBe("active");
	});

	it("counts non-cached input plus output tokens like Codex", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Budgeted");

		const goal = await accountGoalUsage(
			ref,
			{ input: 100, output: 20, cacheRead: 70, cacheWrite: 0, totalTokens: 999 },
			0,
		);

		expect(goal).toMatchObject({ tokensUsed: 50 });
	});

	it("marks active goals budgetLimited when accounting reaches budget", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Budgeted", 50);

		const goal = await accountGoalUsage(
			ref,
			{ input: 31, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 51 },
			4,
		);

		expect(goal).toMatchObject({ status: "budgetLimited", tokensUsed: 51, timeUsedSeconds: 4 });
	});

	it("clears the store while preserving the versioned file", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Temporary");

		expect(await clearGoal(ref)).toBe(true);
		expect(await readGoal(ref)).toBeNull();
	});
});

async function tempStore(threadId = "thread-test"): Promise<GoalStoreRef> {
	const dir = await mkdtemp(join(tmpdir(), "pi-goal-"));
	tempDirs.push(dir);
	return { baseDir: join(dir, "extensions", "pi-goal"), threadId };
}
