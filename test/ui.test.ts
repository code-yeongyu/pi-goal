import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { Goal } from "../src/goal/types.js";
import { goalStatusText, STATUS_KEY, updateGoalUi } from "../src/goal/ui.js";

type SetStatusCall = { key: string; text: string | undefined };

describe("goal status UI", () => {
	it("derives Codex-style status text for each state", () => {
		expect(goalStatusText(testGoal({ status: "active", timeUsedSeconds: 0 }))).toBe("Pursuing goal");
		expect(goalStatusText(testGoal({ status: "active", timeUsedSeconds: 65 }))).toBe("Pursuing goal (1m)");
		expect(goalStatusText(testGoal({ status: "paused" }))).toBe("Goal paused (/goal resume)");
		expect(goalStatusText(testGoal({ status: "complete" }))).toBe("Goal achieved");
	});

	it("sets and clears the status segment, respecting hasUI", () => {
		const calls: SetStatusCall[] = [];
		const ctx = makeUiCtx(true, (key, text) => calls.push({ key, text }));

		updateGoalUi(ctx, testGoal({ status: "active", timeUsedSeconds: 0 }));
		updateGoalUi(ctx, null);
		expect(calls).toEqual([
			{ key: STATUS_KEY, text: "Pursuing goal" },
			{ key: STATUS_KEY, text: undefined },
		]);

		const noUiCalls: SetStatusCall[] = [];
		const noUiCtx = makeUiCtx(false, (key, text) => noUiCalls.push({ key, text }));
		updateGoalUi(noUiCtx, testGoal());
		expect(noUiCalls).toHaveLength(0);
	});
});

function makeUiCtx(hasUI: boolean, setStatus: (key: string, text: string | undefined) => void): ExtensionContext {
	const ctx: Pick<ExtensionContext, "hasUI"> & { ui: Pick<ExtensionContext["ui"], "setStatus"> } = {
		hasUI,
		ui: { setStatus },
	};
	return ctx as never;
}

function testGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		threadId: "thread-1",
		objective: "Port /goal as a pi extension",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 120,
		createdAt: 1_777_766_400,
		updatedAt: 1_777_766_400,
		...overrides,
	};
}
