import { describe, expect, it } from "vitest";

import { buildContinuationPrompt, buildGoalSystemPrompt } from "../src/goal/prompt.js";
import type { Goal } from "../src/goal/types.js";

describe("goal prompts", () => {
	it("keeps objective untrusted in continuation prompt", () => {
		const prompt = buildContinuationPrompt(testGoal("Do the thing"));

		expect(prompt).toContain("<untrusted_objective>\nDo the thing\n</untrusted_objective>");
		expect(prompt).toContain("Avoid repeating work that is already done.");
	});

	it("injects completion audit instructions into the system prompt", () => {
		const prompt = buildGoalSystemPrompt(testGoal("Finish carefully"));

		expect(prompt).toContain("[PERSISTENT GOAL]");
		expect(prompt).toContain("perform a completion audit");
		expect(prompt).toContain('call update_goal with status "complete"');
	});
});

function testGoal(objective: string): Goal {
	return {
		id: "goal-1",
		objective,
		status: "active",
		tokensUsed: 10,
		timeUsedSeconds: 20,
		createdAt: "2026-05-07T00:00:00.000Z",
		updatedAt: "2026-05-07T00:00:00.000Z",
	};
}
