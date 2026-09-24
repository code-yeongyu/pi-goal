#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import process from "node:process";
import { LanguageVariant, SyntaxKind } from "typescript/unstable/ast";
import { createScanner } from "typescript/unstable/ast/scanner";

type RuleId = "no-any-assertion" | "no-unknown-assertion" | "no-ts-ignore" | "no-ts-expect-error" | "no-enum";

type Violation = {
	ruleId: RuleId;
	filePath: string;
	line: number;
	column: number;
	message: string;
};

const INCLUDED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_DIRECTORIES = new Set([
	".git",
	".hg",
	".svn",
	".next",
	".nuxt",
	".turbo",
	".yarn",
	"coverage",
	"dist",
	"build",
	"node_modules",
]);

function isIncludedFile(filePath: string): boolean {
	return INCLUDED_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function isDeclarationFile(filePath: string): boolean {
	return filePath.endsWith(".d.ts") || filePath.endsWith(".d.mts") || filePath.endsWith(".d.cts");
}

function collectInputFiles(inputPaths: string[]): string[] {
	const discoveredFiles = new Set<string>();

	for (const inputPath of inputPaths) {
		const resolvedPath = resolve(inputPath);
		if (!existsSync(resolvedPath)) {
			console.error(`Input path does not exist: ${resolvedPath}`);
			process.exitCode = 2;
			continue;
		}

		walkPath(resolvedPath, discoveredFiles);
	}

	return [...discoveredFiles].sort();
}

function walkPath(currentPath: string, discoveredFiles: Set<string>): void {
	const stat = statSync(currentPath);

	if (stat.isDirectory()) {
		const baseName = currentPath.split("/").at(-1) ?? currentPath;
		if (IGNORED_DIRECTORIES.has(baseName)) return;

		for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
			walkPath(join(currentPath, entry.name), discoveredFiles);
		}
		return;
	}

	if (stat.isFile() && isIncludedFile(currentPath) && !isDeclarationFile(currentPath)) {
		discoveredFiles.add(currentPath);
	}
}

function positionToLineColumn(text: string, pos: number): { line: number; column: number } {
	let line = 1;
	let lastBreak = -1;
	for (let i = 0; i < pos; i++) {
		if (text.charCodeAt(i) === 10) {
			line += 1;
			lastBreak = i;
		}
	}
	return { line, column: pos - lastBreak };
}

function createViolation(filePath: string, text: string, start: number, ruleId: RuleId, message: string): Violation {
	const { line, column } = positionToLineColumn(text, start);
	return { ruleId, filePath, line, column, message };
}

function isTrivia(kind: number): boolean {
	return (
		kind === SyntaxKind.WhitespaceTrivia ||
		kind === SyntaxKind.NewLineTrivia ||
		kind === SyntaxKind.SingleLineCommentTrivia ||
		kind === SyntaxKind.MultiLineCommentTrivia ||
		kind === SyntaxKind.ConflictMarkerTrivia
	);
}

function analyzeFile(filePath: string): Violation[] {
	const fileText = readFileSync(filePath, "utf8");
	const scanner = createScanner(false, LanguageVariant.Standard, fileText);
	const violations: Violation[] = [];
	let awaitingAssertionKeyword = false;
	let assertionOpenParens = 0;

	for (let token = scanner.scan(); token !== SyntaxKind.EndOfFile; token = scanner.scan()) {
		if (token === SyntaxKind.SingleLineCommentTrivia || token === SyntaxKind.MultiLineCommentTrivia) {
			const commentText = scanner.getTokenText();
			const tokenPosition = scanner.getTokenStart();
			if (commentText.includes("@ts-ignore")) {
				violations.push(
					createViolation(
						filePath,
						fileText,
						tokenPosition,
						"no-ts-ignore",
						"Remove `@ts-ignore` and fix the underlying type error.",
					),
				);
			}
			if (commentText.includes("@ts-expect-error")) {
				violations.push(
					createViolation(
						filePath,
						fileText,
						tokenPosition,
						"no-ts-expect-error",
						"Remove `@ts-expect-error` and fix the underlying type error.",
					),
				);
			}
			continue;
		}

		if (isTrivia(token)) continue;

		if (token === SyntaxKind.AsKeyword) {
			awaitingAssertionKeyword = true;
			assertionOpenParens = 0;
			continue;
		}

		if (awaitingAssertionKeyword) {
			if (token === SyntaxKind.OpenParenToken) {
				assertionOpenParens += 1;
				continue;
			}
			if (token === SyntaxKind.CloseParenToken && assertionOpenParens > 0) {
				assertionOpenParens -= 1;
				continue;
			}
			if (token === SyntaxKind.AnyKeyword) {
				violations.push(
					createViolation(
						filePath,
						fileText,
						scanner.getTokenStart(),
						"no-any-assertion",
						"Replace this assertion with real narrowing or validation.",
					),
				);
			} else if (token === SyntaxKind.UnknownKeyword) {
				violations.push(
					createViolation(
						filePath,
						fileText,
						scanner.getTokenStart(),
						"no-unknown-assertion",
						"Do not use `unknown` as an assertion target. Narrow the value instead.",
					),
				);
			}
			awaitingAssertionKeyword = false;
			assertionOpenParens = 0;
		}

		if (token === SyntaxKind.EnumKeyword) {
			violations.push(
				createViolation(
					filePath,
					fileText,
					scanner.getTokenStart(),
					"no-enum",
					"Replace enum with a literal union or discriminated union.",
				),
			);
		}
	}

	return violations;
}

function formatViolation(violation: Violation): string {
	return `${violation.filePath}:${violation.line}:${violation.column} [${violation.ruleId}] ${violation.message}`;
}

function main(): void {
	const inputPaths = process.argv.slice(2);
	if (inputPaths.length === 0) {
		console.error("Usage: bun --install=fallback check-no-excuse-rules.ts <path ...>");
		process.exit(2);
	}

	const files = collectInputFiles(inputPaths);
	if (process.exitCode !== undefined && process.exitCode !== 0) {
		process.exit(process.exitCode);
	}

	const violations = files.flatMap((filePath) => analyzeFile(filePath));

	if (violations.length === 0) {
		console.log(`No no-excuse violations found in ${files.length} file(s).`);
		return;
	}

	for (const violation of violations) {
		console.error(formatViolation(violation));
	}

	console.error(`Found ${violations.length} no-excuse violation(s) in ${files.length} file(s).`);
	process.exit(1);
}

main();
