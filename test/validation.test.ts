import { describe, expect, it } from "vitest";

import { MAX_OBJECTIVE_LENGTH, validateObjective } from "../src/goal/validation.js";

describe("validateObjective", () => {
	it("accepts an objective at the 4,000-code-point limit without truncation", () => {
		const objective = "a".repeat(MAX_OBJECTIVE_LENGTH);

		expect(validateObjective(objective, "thread.objective-full.txt")).toEqual({
			objective,
			truncated: false,
		});
	});

	it("reserves marker space and cuts at a nearby whitespace boundary", () => {
		const objective = `${"word ".repeat(839)}words`;
		const fullTextFileName = "thread%2Fwith%20space.objective-full.txt";
		const marker = `… [truncated; full objective: ${fullTextFileName}]`;

		const validated = validateObjective(objective, fullTextFileName);

		expect(validated).toMatchObject({ truncated: true, fullTextFileName });
		expect([...validated.objective].length).toBeLessThanOrEqual(MAX_OBJECTIVE_LENGTH);
		expect(validated.objective.endsWith(marker)).toBe(true);
		const payload = validated.objective.slice(0, -marker.length);
		expect([...payload].length).toBeGreaterThanOrEqual(MAX_OBJECTIVE_LENGTH - [...marker].length - 200);
		expect(payload.endsWith(" ")).toBe(false);
	});

	it("hard-cuts a whitespace-free objective at the marker-aware payload budget", () => {
		const objective = "a".repeat(5_000);
		const fullTextFileName = "thread.objective-full.txt";
		const marker = `… [truncated; full objective: ${fullTextFileName}]`;
		const payloadBudget = MAX_OBJECTIVE_LENGTH - [...marker].length;

		expect(validateObjective(objective, fullTextFileName)).toEqual({
			objective: `${"a".repeat(payloadBudget)}${marker}`,
			truncated: true,
			fullTextFileName,
		});
	});

	it("still rejects an empty objective", () => {
		expect(() => validateObjective("   ", "thread.objective-full.txt")).toThrow("objective must not be empty");
	});
});
