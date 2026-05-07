import { describe, expect, it } from "vitest";

import { formatGoalElapsedSeconds, goalUsageSummary } from "../src/goal/format.js";
import type { Goal } from "../src/goal/types.js";

describe("goal display formatting", () => {
	it("formats elapsed seconds like Codex TUI", () => {
		expect(formatGoalElapsedSeconds(0)).toBe("0s");
		expect(formatGoalElapsedSeconds(59)).toBe("59s");
		expect(formatGoalElapsedSeconds(60)).toBe("1m");
		expect(formatGoalElapsedSeconds(30 * 60)).toBe("30m");
		expect(formatGoalElapsedSeconds(90 * 60)).toBe("1h 30m");
		expect(formatGoalElapsedSeconds(2 * 60 * 60)).toBe("2h");
		expect(formatGoalElapsedSeconds(24 * 60 * 60 - 1)).toBe("23h 59m");
		expect(formatGoalElapsedSeconds(24 * 60 * 60)).toBe("1d 0h 0m");
		expect(formatGoalElapsedSeconds(2 * 24 * 60 * 60 + 23 * 60 * 60 + 42 * 60)).toBe("2d 23h 42m");
	});

	it("summarizes goal time and budgeted tokens", () => {
		expect(goalUsageSummary(testGoal({ tokenBudget: 50_000, tokensUsed: 63_876 }))).toBe(
			"Objective: Port /goal as a pi extension Time: 2m. Tokens: 63.9K/50K.",
		);
	});
});

function testGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		objective: "Port /goal as a pi extension",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 120,
		createdAt: "2026-05-07T00:00:00.000Z",
		updatedAt: "2026-05-07T00:00:00.000Z",
		...overrides,
	};
}
