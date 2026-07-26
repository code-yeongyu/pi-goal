export const MAX_OBJECTIVE_LENGTH = 4_000;
const WHITESPACE_LOOKBACK = 200;

export type ValidatedObjective = {
	objective: string;
	truncated: boolean;
	fullTextFileName?: string;
};

export function validateObjective(value: string, fullTextFileName: string): ValidatedObjective {
	const objective = value.trim();
	if (objective.length === 0) throw new Error("objective must not be empty");

	const codePoints = [...objective];
	if (codePoints.length <= MAX_OBJECTIVE_LENGTH) return { objective, truncated: false };

	const marker = truncationMarker(fullTextFileName);
	const payloadBudget = MAX_OBJECTIVE_LENGTH - [...marker].length;
	const whitespaceCut = nearestWhitespaceCut(codePoints, payloadBudget);
	const payload = codePoints.slice(0, whitespaceCut ?? payloadBudget).join("");
	return {
		objective: `${payload}${marker}`,
		truncated: true,
		fullTextFileName,
	};
}

export function validateTokenBudget(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("tokenBudget must be a non-negative safe integer");
	return value;
}

export function resolveTokenBudget(current: number | undefined, update: number | null | undefined): number | undefined {
	if (update === undefined) return current;
	return update === null ? undefined : validateTokenBudget(update);
}

export function truncationMarker(fullTextFileName: string): string {
	return `… [truncated; full objective: ${fullTextFileName}]`;
}

export function objectiveTruncationNotice(fullTextFileName: string): string {
	return `Objective was truncated; full objective saved to ${fullTextFileName}.`;
}

function nearestWhitespaceCut(codePoints: string[], payloadBudget: number): number | undefined {
	const minimumCut = Math.max(0, payloadBudget - WHITESPACE_LOOKBACK);
	for (let index = payloadBudget - 1; index >= minimumCut; index -= 1) {
		if (/\s/u.test(codePoints[index] ?? "")) return index;
	}
	return undefined;
}
