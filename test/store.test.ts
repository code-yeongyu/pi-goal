import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { accountGoalUsage, clearGoal, createGoal, goalFilePath, readGoal, updateGoal } from "../src/goal/store.js";
import type { GoalStoreRef } from "../src/goal/types.js";

const tempDirs: string[] = [];

describe("goal store (budget-free)", () => {
	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("creates a persisted active goal with no budget field", async () => {
		const ref = await tempStore("thread-create");
		const goal = await createGoal(ref, "  Ship the extension  ");

		expect(goal.threadId).toBe("thread-create");
		expect(goal.objective).toBe("Ship the extension");
		expect(goal.status).toBe("active");
		expect(goal).not.toHaveProperty("tokenBudget");
		expect(await readGoal(ref)).toMatchObject({ id: goal.id, objective: "Ship the extension" });
		expect(goalFilePath(ref)).toContain(join("extensions", "pi-goal", "thread-create.json"));
		expect(goalFilePath(ref)).not.toContain(".pi");

		const fileContents = await readFile(goalFilePath(ref), "utf8");
		expect(fileContents).toContain('"version": 1');
		expect(fileContents).not.toContain("tokenBudget");
		expect(fileContents).not.toContain("budget");
	});

	it("preserves inert tokenBudget metadata from existing goal files", async () => {
		const ref = await tempStore("token-budget-wire-compat");
		const original = await createGoal(ref, "Persist metadata only");
		await writeFile(
			goalFilePath(ref),
			`${JSON.stringify({ version: 1, goal: { ...original, tokenBudget: 4_096 } })}\n`,
			"utf8",
		);

		const loaded = await readGoal(ref);
		const completed = await updateGoal(ref, { status: "complete" }, "model");

		expect(loaded?.tokenBudget).toBe(4_096);
		expect(completed.tokenBudget).toBe(4_096);
		expect((await readGoal(ref))?.tokenBudget).toBe(4_096);

		await writeFile(
			goalFilePath(ref),
			`${JSON.stringify({ version: 1, goal: { ...original, tokenBudget: -1 } })}\n`,
			"utf8",
		);
		await expect(readGoal(ref)).rejects.toThrow("goal store contains an invalid goal");
	});

	it("spills a byte-identical oversized objective while storing marker-budget-aware text", async () => {
		const ref = await tempStore("thread/oversized objective");
		const objective = "x".repeat(4_200);

		const goal = await createGoal(ref, objective);

		const fullTextFilePath = join(ref.baseDir, `${encodeURIComponent(ref.threadId)}.objective-full.txt`);
		expect([...goal.objective].length).toBeLessThanOrEqual(4_000);
		expect(goal.objective).toContain("[truncated; full objective:");
		expect(await readFile(fullTextFilePath, "utf8")).toBe(objective);
	});

	it("replaces a completed goal and archives it as one history JSON line", async () => {
		const ref = await tempStore("thread/complete-create");
		const original = await createGoal(ref, "Original");
		await updateGoal(ref, { status: "complete" });

		const replacement = await createGoal(ref, "Replacement");

		expect(replacement).toMatchObject({
			objective: "Replacement",
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
		});
		expect(replacement.id).not.toBe(original.id);
		expect(await readGoal(ref)).toMatchObject({ id: replacement.id, objective: "Replacement" });
		const history = await readFile(join(ref.baseDir, `${encodeURIComponent(ref.threadId)}.history.jsonl`), "utf8");
		const historyLines = history.trim().split("\n");
		expect(historyLines).toHaveLength(1);
		expect(JSON.parse(historyLines[0] ?? "")).toMatchObject({
			id: original.id,
			objective: "Original",
			status: "complete",
			completedAt: expect.any(Number),
		});
	});

	it.each(["active", "paused"] as const)("rejects createGoal while a goal is %s", async (status) => {
		const ref = await tempStore(`thread-${status}-create`);
		const original = await createGoal(ref, "Original");
		if (status === "paused") await updateGoal(ref, { status }, "user");

		await expect(createGoal(ref, "Replacement")).rejects.toThrow(
			"cannot create a new goal because this thread already has a goal",
		);
		expect(await readGoal(ref)).toMatchObject({ id: original.id, objective: "Original", status });
	});

	it("replaces changed objectives and preserves usage for status updates", async () => {
		const ref = await tempStore();
		const first = await createGoal(ref, "Original");
		await accountGoalUsage(ref, { input: 23, output: 2, cacheRead: 0, cacheWrite: 4, totalTokens: 25 }, 70);

		const paused = await updateGoal(ref, { status: "paused" }, "user");
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
		const paused = await updateGoal(ref, { status: "paused" }, "user");

		const resumed = await updateGoal(ref, { objective: "Same" }, "user");

		expect(paused.id).toBe(first.id);
		expect(resumed.id).toBe(first.id);
		expect(resumed.status).toBe("active");
	});

	it.each([
		["active", "active", true],
		["active", "paused", false],
		["active", "blocked", true],
		["active", "complete", true],
		["paused", "active", false],
		["paused", "paused", true],
		["paused", "blocked", false],
		["paused", "complete", false],
		["blocked", "active", false],
		["blocked", "paused", false],
		["blocked", "blocked", true],
		["blocked", "complete", true],
		["complete", "active", false],
		["complete", "paused", false],
		["complete", "blocked", false],
		["complete", "complete", true],
	] as const)("allows model transition %s -> %s: %s", async (from, to, allowed) => {
		const ref = await tempStore(`model-${from}-${to}`);
		await createGoal(ref, "Transition matrix");
		if (from === "paused") await updateGoal(ref, { status: "paused" }, "user");
		if (from === "blocked") await updateGoal(ref, { status: "blocked", reason: "Waiting on a decision" }, "model");
		if (from === "complete") await updateGoal(ref, { status: "complete" }, "model");

		const update = to === "blocked" ? { status: to, reason: "Waiting on a decision" } : { status: to };
		const transition = updateGoal(ref, update, "model");
		if (allowed) {
			await expect(transition).resolves.toMatchObject({ status: to });
			return;
		}
		await expect(transition).rejects.toThrow(`illegal goal transition: ${from} -> ${to}`);
	});

	it("allows user and system active-paused transitions plus blocked resume", async () => {
		const ref = await tempStore("user-transitions");
		await createGoal(ref, "Transition matrix");

		const paused = await updateGoal(ref, { status: "paused" }, "user");
		const resumed = await updateGoal(ref, { status: "active" }, "user");
		const blocked = await updateGoal(ref, { status: "blocked", reason: "Waiting on a decision" }, "model");
		const resumedBlocked = await updateGoal(ref, { status: "active" }, "user");

		expect(paused.status).toBe("paused");
		expect(resumed.status).toBe("active");
		expect(blocked.status).toBe("blocked");
		expect(resumedBlocked.status).toBe("active");
		expect(resumedBlocked).not.toHaveProperty("blockedReason");
		expect(resumedBlocked).not.toHaveProperty("blockedAt");
	});

	it("maintains blocked fields, clears them outside blocked, and keeps repeated updates idempotent", async () => {
		const ref = await tempStore("blocked-invariants");
		await createGoal(ref, "Wait for a decision");

		const blocked = await updateGoal(ref, { status: "blocked", reason: "Waiting on a decision" }, "model");
		const repeated = await updateGoal(ref, { status: "blocked", reason: "Different reason" }, "model");
		const completed = await updateGoal(ref, { status: "complete" }, "model");

		expect(blocked).toMatchObject({
			status: "blocked",
			blockedReason: "Waiting on a decision",
			blockedAt: expect.any(Number),
		});
		expect(repeated).toMatchObject({
			status: "blocked",
			blockedReason: blocked.blockedReason,
			blockedAt: blocked.blockedAt,
		});
		expect(repeated.updatedAt).toBeGreaterThan(blocked.updatedAt);
		expect(completed.status).toBe("complete");
		expect(completed).not.toHaveProperty("blockedReason");
		expect(completed).not.toHaveProperty("blockedAt");
	});

	it("rejects persisted blocked-goal invariant violations while accepting a v1 goal without blocked fields", async () => {
		const ref = await tempStore("v1-goal");
		const filePath = goalFilePath(ref);
		await mkdir(dirname(filePath), { recursive: true });
		const v1ActiveGoal = {
			id: "v1-goal",
			threadId: ref.threadId,
			objective: "Old persisted goal",
			status: "active",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 1,
			lastStartedAt: 1,
		};
		await writeFile(filePath, `${JSON.stringify({ version: 1, goal: v1ActiveGoal })}\n`, "utf8");
		expect(await readGoal(ref)).toMatchObject(v1ActiveGoal);

		await writeFile(
			filePath,
			`${JSON.stringify({ version: 1, goal: { ...v1ActiveGoal, status: "blocked" } })}\n`,
			"utf8",
		);
		await expect(readGoal(ref)).rejects.toThrow("goal store contains an invalid goal");
	});

	it("counts non-cached input plus output tokens", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Tracked");

		const goal = await accountGoalUsage(
			ref,
			{ input: 100, output: 20, cacheRead: 70, cacheWrite: 0, totalTokens: 999 },
			0,
		);

		expect(goal).toMatchObject({ tokensUsed: 120 });
	});

	it("never transitions status from accounting, regardless of token volume", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Tracked");

		const goal = await accountGoalUsage(
			ref,
			{ input: 10_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10_000_000 },
			4,
		);

		expect(goal?.status).toBe("active");
		expect(goal?.tokensUsed).toBe(10_000_000);
		expect(goal?.timeUsedSeconds).toBe(4);
	});

	it("only accounts active usage unless the completing turn is finalized", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Tracked");
		await updateGoal(ref, { status: "paused" }, "user");

		const activeOnly = await accountGoalUsage(
			ref,
			{ input: 25, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 25 },
			3,
			"active",
		);
		expect(activeOnly).toMatchObject({ status: "paused", tokensUsed: 0, timeUsedSeconds: 0 });
	});

	it("finalizes usage of a blocked turn under activeOrBlocked", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Tracked");
		await updateGoal(ref, { status: "blocked", reason: "Waiting on a decision" }, "model");

		const finalized = await accountGoalUsage(
			ref,
			{ input: 25, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 30 },
			3,
			"activeOrBlocked",
		);
		expect(finalized).toMatchObject({ status: "blocked", tokensUsed: 30, timeUsedSeconds: 3 });
	});

	it("finalizes usage of the completing turn under activeOrComplete", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Tracked");
		await updateGoal(ref, { status: "complete" });

		const finalized = await accountGoalUsage(
			ref,
			{ input: 25, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 30 },
			3,
			"activeOrComplete",
		);
		expect(finalized).toMatchObject({ status: "complete", tokensUsed: 30, timeUsedSeconds: 3 });
	});

	it("marks a goal complete and stamps completedAt", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Finish me");

		const completed = await updateGoal(ref, { status: "complete" });
		expect(completed.status).toBe("complete");
		expect(typeof completed.completedAt).toBe("number");
		expect(completed.lastStartedAt).toBeUndefined();
	});

	it("clears the store while preserving the versioned file", async () => {
		const ref = await tempStore();
		await createGoal(ref, "Temporary");

		expect(await clearGoal(ref)).toBe(true);
		expect(await readGoal(ref)).toBeNull();
		expect(await readFile(goalFilePath(ref), "utf8")).toContain('"version": 1');
	});
});

async function tempStore(threadId = "thread-test"): Promise<GoalStoreRef> {
	const dir = await mkdtemp(join(tmpdir(), "pi-goal-"));
	tempDirs.push(dir);
	return { baseDir: join(dir, "extensions", "pi-goal"), threadId };
}
