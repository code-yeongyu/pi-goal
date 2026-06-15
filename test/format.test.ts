import { describe, expect, it } from "vitest";

import {
	formatGoalElapsedSeconds,
	formatGoalForTool,
	formatTokensCompact,
	goalToolResponse,
} from "../src/goal/format.js";
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

	it("formats compact token counts", () => {
		expect(formatTokensCompact(999)).toBe("999");
		expect(formatTokensCompact(1_500)).toBe("1.5K");
		expect(formatTokensCompact(2_000_000)).toBe("2M");
	});

	it("renders the tool view without any budget fields", () => {
		const text = formatGoalForTool(testGoal({ tokensUsed: 1_200, timeUsedSeconds: 65 }));

		expect(text).toContain("Objective: Port /goal as a pi extension");
		expect(text).toContain("Status: active");
		expect(text).toContain("Time used: 1m");
		expect(text).toContain("Tokens used: 1.2K");
		expect(text.toLowerCase()).not.toContain("budget");
		expect(text.toLowerCase()).not.toContain("remaining");
	});

	it("produces a snapshot tool response with no budget keys", () => {
		const response = goalToolResponse(
			testGoal({ status: "complete", tokensUsed: 3_250, timeUsedSeconds: 75, completedAt: 1_777_766_500 }),
		);

		expect(response).toMatchObject({
			goal: {
				threadId: "thread-1",
				objective: "Port /goal as a pi extension",
				status: "complete",
				tokensUsed: 3_250,
				timeUsedSeconds: 75,
				createdAt: 1_777_766_400,
			},
		});
		const serialized = JSON.stringify(response);
		expect(serialized.toLowerCase()).not.toContain("budget");
		expect(serialized.toLowerCase()).not.toContain("remaining");
		expect(goalToolResponse(null).goal).toBeNull();
	});
});

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
