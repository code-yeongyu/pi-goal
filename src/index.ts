import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerGoalCommand } from "./goal/command-registration.js";
import { registerGoalLifecycle } from "./goal/lifecycle.js";
import { registerGoalTools } from "./goal/tool-registration.js";
import type { GoalStoreRef } from "./goal/types.js";

export default function goalExtension(pi: ExtensionAPI): void {
	const lifecycle = registerGoalLifecycle(pi, goalStoreRef);
	registerGoalTools(pi, { goalStoreRef, ...lifecycle });
	registerGoalCommand(pi, { goalStoreRef, ...lifecycle });
}

function goalStoreRef(ctx: ExtensionContext): GoalStoreRef {
	const sessionFile = ctx.sessionManager.getSessionFile();
	const baseDir =
		sessionFile === undefined
			? join(agentDir(), "extensions", "pi-goal", "no-session", cwdStoreKey(ctx.cwd))
			: join(ctx.sessionManager.getSessionDir(), "extensions", "pi-goal");

	return {
		baseDir,
		threadId: ctx.sessionManager.getSessionId(),
	};
}

function agentDir(): string {
	return process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
}

function cwdStoreKey(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 24);
}
