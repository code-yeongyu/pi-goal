import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { readGoal } from "../src/goal/store.js";
import type { GoalStoreRef } from "../src/goal/types.js";
import { goalFooterIndicator } from "../src/goal/ui.js";
import piGoalExtension from "../src/index.js";

type ToolResult = {
	content: { type: "text"; text: string }[];
};

type GoalContext = {
	hasUI: false;
	cwd: string;
	sessionManager: {
		getSessionFile(): string;
		getSessionDir(): string;
		getSessionId(): string;
	};
	isIdle(): boolean;
	hasPendingMessages(): boolean;
};

type RegisteredTool = {
	name: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: GoalContext,
	): Promise<ToolResult>;
};

type EventPayload = {
	type: string;
	messages?: unknown[];
};

type EventHandler = (event: EventPayload, ctx: GoalContext) => unknown | Promise<unknown>;

type GoalExtensionApi = {
	registerTool(tool: RegisteredTool): void;
	registerCommand(name: string, options: { handler(args: string, ctx: GoalContext): Promise<void> }): void;
	on(event: string, handler: EventHandler): void;
	sendMessage(
		message: { customType: string; content: string; display: boolean },
		options: Record<string, unknown>,
	): void;
};

type GoalExtensionFactory = (pi: GoalExtensionApi) => void;

const tempDirs: string[] = [];

describe("pi-goal extension accounting", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("starts elapsed-time accounting when a goal is created during an active agent turn", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const harness = createHarness();
		const ctx = await createContext("thread-create-during-turn");

		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		vi.advanceTimersByTime(30_000);
		await harness
			.tool("create_goal")
			.execute("create-goal", { objective: "created after the turn started" }, undefined, undefined, ctx);
		vi.advanceTimersByTime(10_000);

		await harness.emit("agent_end", { type: "agent_end", messages: [] }, ctx);

		const goal = await readGoal(refForContext(ctx));
		expect(goal?.timeUsedSeconds).toBe(10);
	});

	it("finalizes elapsed time and usage when update_goal completes an active turn", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const harness = createHarness();
		const ctx = await createContext("thread-complete-during-turn");

		await harness
			.tool("create_goal")
			.execute("create-goal", { objective: "finish in this turn" }, undefined, undefined, ctx);
		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		vi.advanceTimersByTime(65_000);

		const completion = await harness
			.tool("update_goal")
			.execute("complete-goal", { status: "complete" }, undefined, undefined, ctx);

		const completedGoal = await readGoal(refForContext(ctx));
		expect(completedGoal?.status).toBe("complete");
		expect(completedGoal?.timeUsedSeconds).toBe(65);
		expect(completedGoal === null ? "" : goalFooterIndicator(completedGoal).text).toBe("Goal achieved (1m)");
		expect(toolResultText(completion)).toContain('"timeUsedSeconds": 65');

		vi.advanceTimersByTime(5_000);
		await harness.emit(
			"agent_end",
			{
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						usage: { input: 100, output: 20, cacheRead: 60, cacheWrite: 0, totalTokens: 120 },
					},
				],
			},
			ctx,
		);

		const finalizedGoal = await readGoal(refForContext(ctx));
		expect(finalizedGoal?.tokensUsed).toBe(60);
		expect(finalizedGoal?.timeUsedSeconds).toBe(70);
	});
});

function createHarness(): {
	tool(name: string): RegisteredTool;
	emit(event: string, payload: EventPayload, ctx: GoalContext): Promise<void>;
} {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, EventHandler[]>();
	const installGoalExtension = piGoalExtension as GoalExtensionFactory;

	installGoalExtension({
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		on(event, handler) {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		sendMessage() {},
	});

	return {
		tool(name) {
			const tool = tools.get(name);
			if (tool === undefined) throw new Error(`tool not registered: ${name}`);
			return tool;
		},
		async emit(event, payload, ctx) {
			for (const handler of handlers.get(event) ?? []) {
				await handler(payload, ctx);
			}
		},
	};
}

async function createContext(threadId: string): Promise<GoalContext> {
	const sessionDir = await mkdtemp(join(tmpdir(), "pi-goal-extension-"));
	tempDirs.push(sessionDir);
	return {
		hasUI: false,
		cwd: sessionDir,
		sessionManager: {
			getSessionFile: () => join(sessionDir, "session.json"),
			getSessionDir: () => sessionDir,
			getSessionId: () => threadId,
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
	};
}

function refForContext(ctx: GoalContext): GoalStoreRef {
	return {
		baseDir: join(ctx.sessionManager.getSessionDir(), "extensions", "pi-goal"),
		threadId: ctx.sessionManager.getSessionId(),
	};
}

function toolResultText(result: ToolResult): string {
	const firstContent = result.content[0];
	if (firstContent === undefined) throw new Error("tool result had no text content");
	return firstContent.text;
}
