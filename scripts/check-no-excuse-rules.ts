#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import process from "node:process";
import ts from "typescript";

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

function getScriptKind(filePath: string): ts.ScriptKind {
	const extension = extname(filePath).toLowerCase();

	switch (extension) {
		case ".tsx":
			return ts.ScriptKind.TSX;
		case ".jsx":
		case ".js":
		case ".mjs":
		case ".cjs":
			return ts.ScriptKind.JS;
		default:
			return ts.ScriptKind.TS;
	}
}

function createViolation(sourceFile: ts.SourceFile, start: number, ruleId: RuleId, message: string): Violation {
	const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);

	return {
		ruleId,
		filePath: sourceFile.fileName,
		line: line + 1,
		column: character + 1,
		message,
	};
}

function getTypeAssertionKeywordKind(typeNode: ts.TypeNode): ts.SyntaxKind | null {
	if (ts.isParenthesizedTypeNode(typeNode)) return getTypeAssertionKeywordKind(typeNode.type);
	if (typeNode.kind === ts.SyntaxKind.AnyKeyword || typeNode.kind === ts.SyntaxKind.UnknownKeyword) {
		return typeNode.kind;
	}
	return null;
}

function findNodeViolations(sourceFile: ts.SourceFile): Violation[] {
	const violations: Violation[] = [];

	function visit(node: ts.Node): void {
		if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
			const keywordKind = getTypeAssertionKeywordKind(node.type);

			if (keywordKind === ts.SyntaxKind.AnyKeyword) {
				violations.push(
					createViolation(
						sourceFile,
						node.type.getStart(sourceFile),
						"no-any-assertion",
						"Replace this assertion with real narrowing or validation.",
					),
				);
			}

			if (keywordKind === ts.SyntaxKind.UnknownKeyword) {
				violations.push(
					createViolation(
						sourceFile,
						node.type.getStart(sourceFile),
						"no-unknown-assertion",
						"Do not use `unknown` as an assertion target. Narrow the value instead.",
					),
				);
			}
		}

		if (ts.isEnumDeclaration(node)) {
			violations.push(
				createViolation(
					sourceFile,
					node.name.getStart(sourceFile),
					"no-enum",
					"Replace enum with a literal union or discriminated union.",
				),
			);
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return violations;
}

function findCommentViolations(sourceFile: ts.SourceFile): Violation[] {
	const violations: Violation[] = [];
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, sourceFile.text);

	for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
		if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) {
			continue;
		}

		const commentText = scanner.getTokenText();
		const tokenPosition = scanner.getTokenPos();

		if (commentText.includes("@ts-ignore")) {
			violations.push(
				createViolation(
					sourceFile,
					tokenPosition,
					"no-ts-ignore",
					"Remove `@ts-ignore` and fix the underlying type error.",
				),
			);
		}

		if (commentText.includes("@ts-expect-error")) {
			violations.push(
				createViolation(
					sourceFile,
					tokenPosition,
					"no-ts-expect-error",
					"Remove `@ts-expect-error` and fix the underlying type error.",
				),
			);
		}
	}

	return violations;
}

function analyzeFile(filePath: string): Violation[] {
	const fileText = readFileSync(filePath, "utf8");
	const sourceFile = ts.createSourceFile(filePath, fileText, ts.ScriptTarget.Latest, true, getScriptKind(filePath));

	return [...findNodeViolations(sourceFile), ...findCommentViolations(sourceFile)];
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
