import { describe, expect, it } from "vitest";

import { TurnUsageTracker } from "../src/goal/turn-usage.js";

function assistantMessage(input: number, output: number): unknown {
	return {
		role: "assistant",
		usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output },
	};
}

describe("TurnUsageTracker", () => {
	it("accounts streamed pending usage once and returns only the remainder at agent end", () => {
		const tracker = new TurnUsageTracker();
		const first = assistantMessage(100, 50);
		const second = assistantMessage(10, 5);

		tracker.noteMessageEnd(first);
		expect(tracker.takePending()).toMatchObject({ input: 100, output: 50, totalTokens: 150 });
		tracker.noteMessageEnd(second);
		expect(tracker.takeRemaining([first, second])).toMatchObject({ input: 10, output: 5, totalTokens: 15 });
	});

	it("discards streamed usage from before a new accounting window", () => {
		const tracker = new TurnUsageTracker();
		const before = assistantMessage(1000, 500);
		const after = assistantMessage(10, 5);

		tracker.noteMessageEnd(before);
		tracker.discardPending();
		tracker.noteMessageEnd(after);

		expect(tracker.takeRemaining([before, after])).toMatchObject({ input: 10, output: 5, totalTokens: 15 });
	});
});
