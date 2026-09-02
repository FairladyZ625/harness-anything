#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { exitCodeFor, lineNumber, parseCommonArgs, parseTypeScript } from "./ontology-gate-lib.mjs";

const eventReadPaths = Object.freeze([
  "packages/daemon/src/task-query-read.ts",
  "packages/daemon/src/repo-cell-task-query.ts",
  "packages/daemon/src/agent-runtime-read.ts",
]);
const legacyReadCalls = new Set([
  "readRelationGraphProjection",
  "readFile",
  "readFileSync",
  "readMarkdown",
  "readTaskPackage",
]);
const materializedFields = new Set(["coverageRows", "edges", "factAnchors", "facts", "taskRows", "warnings"]);

export function auditEventReadTruth(rootDir = process.cwd()) {
  const findings = [];
  for (const file of eventReadPaths) {
    const sourceFile = parseTypeScript(rootDir, file);
    visit(sourceFile);

    function report(node, reason) {
      findings.push({ file, line: lineNumber(sourceFile, node.getStart(sourceFile)), reason });
    }

    function visit(node) {
      if (ts.isImportSpecifier(node) && legacyReadCalls.has(node.name.text)) {
        report(node, `imports legacy truth reader ${node.name.text}`);
      } else if (ts.isCallExpression(node)) {
        const called = callName(node.expression);
        if (called && legacyReadCalls.has(called)) report(node, `event read calls legacy truth reader ${called}`);
      } else if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "materialized" &&
        materializedFields.has(node.name.text)
      ) {
        report(node, `materialized/L1 ${node.name.text} participates in event read output`);
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
        const fallback = node.right.getText(sourceFile);
        if (/\b(?:source\?\.packageDisposition|l2\.get\s*\()/u.test(fallback)) {
          report(node, `L2 packageDisposition fallback participates: ${fallback}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    if (file === "packages/daemon/src/agent-runtime-read.ts") auditRuntimeEventCut(sourceFile, report);
  }
  const deduped = [
    ...new Map(findings.map((finding) => [`${finding.file}:${finding.line}:${finding.reason}`, finding])).values(),
  ];
  return { findings: deduped.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line) };
}

function auditRuntimeEventCut(sourceFile, report) {
  let handler = null;
  visit(sourceFile);
  if (handler === null) {
    report(sourceFile, "runtime event read handler is missing");
    return;
  }
  const source = findNode(
    handler,
    (node) => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "source",
  );
  if (!source || !projectionWatermark(source.initializer, sourceFile))
    report(handler, "runtime event source cursor must come from the projection reader watermark");

  function visit(node) {
    if (
      handler === null &&
      ts.isPropertyAssignment(node) &&
      node.name.getText(sourceFile) === "events" &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    )
      handler = node.initializer;
    ts.forEachChild(node, visit);
  }
}

function findNode(root, matches) {
  let found = null;
  visit(root);
  return found;

  function visit(node) {
    if (found !== null) return;
    if (matches(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
}

function projectionWatermark(expression, sourceFile) {
  return (
    expression !== undefined &&
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "watermark" &&
    ts.isCallExpression(expression.expression) &&
    expression.expression.expression.getText(sourceFile) === "input.projection.readCut"
  );
}

function callName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : null;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { rootDir, mode } = parseCommonArgs(argv);
    const result = auditEventReadTruth(rootDir);
    console.log(`G0-3 ontology-event-read-truth: ${mode}`);
    console.log(`legacy truth participation points (${result.findings.length}):`);
    for (const finding of result.findings) console.log(`- ${finding.file}:${finding.line} ${finding.reason}`);
    return exitCodeFor(mode, result.findings.length);
  } catch (error) {
    console.error(`G0-3 ontology-event-read-truth: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
