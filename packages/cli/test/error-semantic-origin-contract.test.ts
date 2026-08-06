// harness-test-tier: fast
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const sourceRoot = path.resolve("packages/cli/src");

const allowedProseInspections = [
  "packages/cli/src/cli/error-mapper.ts:reason.startsWith(prefix)",
  "packages/cli/src/cli/error-mapper.ts:reason.startsWith(prefix)",
  "packages/cli/src/commands/core/task-gate-receipt.ts:/closeout/i.test(hint)",
  "packages/cli/src/commands/core/task-gate-receipt.ts:hint.startsWith(\"Task completion has \")",
  "packages/cli/src/commands/core/task-lifecycle-facade-guidance.ts:/already exists/iu.test(failure.error?.hint ?? \"\")",
  "packages/cli/src/commands/core/task-lifecycle-facade-guidance.ts:/requires an active lease|not held by the caller/iu.test(hint)",
  "packages/cli/src/daemon/client.ts:/\\bsettings\\.daemon\\b/u.test(hint)"
].sort();

test("CLI semantic branches do not reconstruct machine meaning from reason or hint prose", () => {
  assert.deepEqual(findProseSemanticInspections(), allowedProseInspections);
});

function findProseSemanticInspections(): ReadonlyArray<string> {
  const sites: string[] = [];
  for (const filePath of walkTypeScriptFiles(sourceRoot)) {
    const source = readFileSync(filePath, "utf8");
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isTextMatcher(node.expression) && containsReasonOrHint(node)) {
        sites.push(site(filePath, node.getText(sourceFile)));
      }
      if (ts.isBinaryExpression(node) && comparesProseLiteral(node) && containsReasonOrHint(node)) {
        sites.push(site(filePath, node.getText(sourceFile)));
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return sites.sort();
}

function isTextMatcher(expression: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(expression)) return false;
  if (expression.name.text === "match") return containsReasonOrHint(expression.expression);
  return ["endsWith", "includes", "startsWith", "test"].includes(expression.name.text);
}

function containsReasonOrHint(node: ts.Node): boolean {
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(candidate) && (candidate.text === "reason" || candidate.text === "hint")) {
      found = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

function comparesProseLiteral(node: ts.BinaryExpression): boolean {
  if (![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)) return false;
  const literal = ts.isStringLiteral(node.left) ? node.left : ts.isStringLiteral(node.right) ? node.right : undefined;
  return literal !== undefined && /\s/u.test(literal.text.trim());
}

function site(filePath: string, expression: string): string {
  const relativePath = path.relative(process.cwd(), filePath).split(path.sep).join("/");
  return `${relativePath}:${expression.replace(/\s+/gu, " ").trim()}`;
}

function walkTypeScriptFiles(directory: string): ReadonlyArray<string> {
  return readdirSync(directory).flatMap((entry) => {
    const filePath = path.join(directory, entry);
    if (statSync(filePath).isDirectory()) return walkTypeScriptFiles(filePath);
    return filePath.endsWith(".ts") ? [filePath] : [];
  });
}
