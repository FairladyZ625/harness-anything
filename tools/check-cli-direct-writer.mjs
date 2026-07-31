#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const sourceRoots = ["packages/cli/src"];
const directConsumerRoots = ["packages/cli/src", "packages/cli/test", "tools"];
const coordinatorFactories = new Set([
  "makeJournaledWriteCoordinator",
  "makeLocalWriteCoordinator",
  "makeOperationalJournaledWriteCoordinator"
]);

export function checkCliDirectWriter(root = process.cwd()) {
  const findings = [
    ...sourceRoots.flatMap((sourceRoot) => walkSourceFiles(root, sourceRoot)).flatMap((rel) => inspectCoordinatorConstruction(root, rel)),
    ...directConsumerRoots.flatMap((sourceRoot) => walkSourceFiles(root, sourceRoot)).flatMap((rel) => inspectDirectConsumers(root, rel))
  ];
  const unique = new Map(findings.map((finding) => [`${finding.file}:${finding.line}:${finding.column}:${finding.kind}`, finding]));
  return { violations: [...unique.values()].sort(compareFindings) };
}

function inspectCoordinatorConstruction(root, rel) {
  const sourceFile = parseSource(root, rel);
  const findings = [];
  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const coordinator = coordinatorFactoryName(node.expression);
    if (coordinator && !allowedCoordinatorConstruction(rel, node, sourceFile)) {
      findings.push(finding(rel, node.expression, sourceFile, "coordinator", `constructs ${coordinator} outside daemon injection, bootstrap, or guarded recovery`));
      return;
    }
  });
  return findings;
}

function inspectDirectConsumers(root, rel) {
  const sourceFile = parseSource(root, rel);
  const findings = [];
  visit(sourceFile, (node) => {
    if (!isDirectModeConsumer(node, sourceFile)) return;
    if (allowedDirectConsumer(rel, node, sourceFile)) return;
    findings.push(finding(rel, node, sourceFile, "direct-consumer", "consumes CLI direct/test-writer configuration outside the operator-recovery contract surfaces"));
  });
  return findings;
}

function allowedCoordinatorConstruction(rel, node, sourceFile) {
  if (rel.startsWith("packages/cli/src/daemon/")) return true;
  if (rel === "packages/cli/src/composition/adapter-registry.ts") return true;
  if (rel === "packages/cli/src/composition/command-executor.ts") {
    return guardedByDeclaredLocalCoordinatorScope(node, sourceFile);
  }
  return rel === "packages/cli/src/commands/core/init.ts" || rel === "packages/cli/src/commands/init.ts";
}

function guardedByDeclaredLocalCoordinatorScope(node, sourceFile) {
  const condition = ancestor(node, ts.isConditionalExpression)?.condition;
  if (!condition || condition.getText(sourceFile) !== "allowLocalCoordinator") return false;
  const declaration = findVariableDeclaration(sourceFile, "allowLocalCoordinator");
  const guard = declaration?.initializer?.getText(sourceFile) ?? "";
  return guard.includes('options.localCoordinatorScope === "recovery"')
    && guard.includes('options.localCoordinatorScope === "test-fixture"')
    && guard.includes('options.localCoordinatorScope === "migration"')
    && guard.includes("isDeclaredLocalMigrationWriteAction(command.action)");
}

function findVariableDeclaration(sourceFile, name) {
  let match;
  visit(sourceFile, (node) => {
    if (!match && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) match = node;
  });
  return match;
}

function allowedDirectConsumer(rel, node, sourceFile) {
  if (rel === "packages/cli/test/direct-mode-fail-close.test.ts") return true;
  if (rel === "tools/smoke-direct-recovery.mjs") return true;
  if (rel !== "packages/cli/src/index.ts") return false;
  const expression = ancestor(node, ts.isExpression) ?? node;
  const context = sourceFile.text.slice(Math.max(0, expression.getStart(sourceFile) - 300), Math.min(sourceFile.text.length, expression.getEnd() + 300));
  return context.includes("HARNESS_DIRECT_WRITE_REASON") && context.includes('"recovery"');
}

function isDirectModeConsumer(node, sourceFile) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /daemonMode/iu.test(node.name.text)) {
    return node.initializer !== undefined && containsDirectLiteral(node.initializer);
  }
  if (ts.isPropertyAssignment(node) && propertyName(node.name) === "HARNESS_DIRECT_WRITE_REASON") {
    return ts.isStringLiteral(node.initializer) && node.initializer.text === "test";
  }
  if (ts.isPropertyAssignment(node) && propertyName(node.name) === "HARNESS_DAEMON_MODE") {
    return isDirectLiteral(node.initializer);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return node.left.getText(sourceFile).endsWith("HARNESS_DAEMON_MODE") && isDirectLiteral(node.right);
  }
  return false;
}

function containsDirectLiteral(node) {
  if (isDirectLiteral(node)) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && containsDirectLiteral(child)) found = true;
  });
  return found;
}

function coordinatorFactoryName(expression) {
  if (ts.isIdentifier(expression) && coordinatorFactories.has(expression.text)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === "createWriteCoordinator") return expression.name.text;
  return undefined;
}

function walkSourceFiles(root, relRoot) {
  const absolute = path.join(root, relRoot);
  if (!existsSync(absolute)) return [];
  return ts.sys.readDirectory(absolute, [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"], undefined, undefined)
    .filter((entry) => statSync(entry).isFile() && !entry.endsWith(".d.ts"))
    .map((entry) => path.relative(root, entry).split(path.sep).join("/"))
    .filter((entry) => entry !== "tools/check-cli-direct-writer.mjs")
    .sort();
}

function parseSource(root, rel) {
  const text = readFileSync(path.join(root, rel), "utf8");
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
}

function finding(file, node, sourceFile, kind, message) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file, line: line + 1, column: character + 1, kind, message };
}

function compareFindings(left, right) {
  return left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column || left.kind.localeCompare(right.kind);
}

function ancestor(node, predicate) {
  let current = node.parent;
  while (current) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function propertyName(name) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

function isDirectLiteral(node) {
  return ts.isStringLiteral(node) && node.text === "direct";
}

function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function main() {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag >= 0 && process.argv[rootFlag + 1] ? path.resolve(process.argv[rootFlag + 1]) : process.cwd();
  const result = checkCliDirectWriter(root);
  if (result.violations.length > 0) {
    console.error("CLI direct-writer check failed:");
    for (const violation of result.violations) {
      console.error(`- ${violation.file}:${violation.line}:${violation.column} [${violation.kind}] ${violation.message}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("CLI direct-writer check passed (no undeclared CLI coordinator or direct consumer).");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
