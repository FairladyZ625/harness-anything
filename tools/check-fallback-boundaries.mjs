import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import {
  callName,
  exactSync,
  functionName,
  loadEntries,
  parsedSource,
  productionSourceFiles,
  visit,
} from "./gates/syntax-boundary-utils.mjs";

const gateId = "check-fallback-boundaries";
const allowlistPath = `tools/gate-allowlists/${gateId}.json`;
const update = process.argv.includes("--update");
const rootArg = process.argv.slice(2).find((argument) => argument !== "--update");
const root = path.resolve(rootArg ?? process.cwd());
const excluded = new Set(["tools/gates/syntax-boundary-utils.mjs", "tools/check-fallback-boundaries.mjs"]);
const consume = new Set();
const scans = new Set();
const substitutions = new Set();
const offlineMaintenanceFullHistoryReaders = new Set([
  "packages/storage/src/projection/rebuildable-task-projection-event-application.ts#catchUpRound",
  "packages/storage/src/store/ledger-backup.ts#readSqliteEvents",
  "packages/storage/src/store/sqlite-event-store.ts#migrateEventsToSqlite",
  "packages/storage/src/store/sqlite-task-event-publication.ts#publishConvertedGeneration",
  "packages/storage/src/store/sqlite-task-event-publication.ts#readCertifiedGitFollower",
  "packages/storage/src/store/sqlite-task-event-publication.ts#ledgerWorktreeBaseline",
]);

function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function isUndefinedExpression(node) {
  return !node || (ts.isIdentifier(node) && node.text === "undefined") || ts.isVoidExpression(node);
}

function isStartArgument(node) {
  const value = unwrapExpression(node);
  return (
    isUndefinedExpression(value) ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isNumericLiteral(value) && value.text === "0")
  );
}

function hasIdentifierText(node, text) {
  return Boolean(node && ts.isIdentifier(node) && node.text === text);
}

// React Query key builders share method names with ledger reads (runtimeQueryKeys.events);
// calls on that receiver only build cache keys and never touch the ledger.
function isQueryKeyBuilderCall(callee) {
  return (
    ts.isPropertyAccessExpression(callee) && hasIdentifierText(unwrapExpression(callee.expression), "runtimeQueryKeys")
  );
}

function isRuntimeReadsEventsCall(callee) {
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isPropertyAccessExpression(unwrapExpression(callee.expression)) &&
    unwrapExpression(callee.expression).name.text === "runtimeReads"
  );
}

function isClientEventsResetCall(node) {
  const afterCursor = unwrapExpression(node.arguments[2]);
  return (
    node.arguments.length < 3 ||
    isUndefinedExpression(afterCursor) ||
    (ts.isStringLiteralLike(afterCursor) && afterCursor.text === "lifecycle:0")
  );
}

function isFullHistoryCall(node) {
  const callee = unwrapExpression(node.expression);
  if (isQueryKeyBuilderCall(callee)) return false;
  const name = callName(callee);
  if (name === "readEventsThrough") return true;
  if (name === "readBatch") return isStartArgument(node.arguments[0]);
  if (name === "readPendingEvents")
    return node.arguments.some((argument) => {
      const value = unwrapExpression(argument);
      return ts.isNumericLiteral(value) && value.text === "0";
    });
  if (name === "events") {
    if (isRuntimeReadsEventsCall(callee)) return false;
    if (
      ts.isPropertyAccessExpression(callee) &&
      hasIdentifierText(unwrapExpression(callee.expression), "agentRuntimeClient")
    ) {
      return isClientEventsResetCall(node);
    }
    return node.arguments.length === 0;
  }
  return name === "read" && ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === "events";
}

function visitCatchBody(node, callback) {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return;
  callback(node);
  ts.forEachChild(node, (child) => visitCatchBody(child, callback));
}

function key(file, node) {
  return `${file}#${functionName(node)}`;
}

for (const entry of await productionSourceFiles(root, excluded)) {
  const { source, relative } = await parsedSource(entry);
  visit(source, (node) => {
    if (ts.isCallExpression(node)) {
      if (callName(node.expression) === "consumeKnownError") consume.add(key(relative, node));
      if (isFullHistoryCall(node) && !offlineMaintenanceFullHistoryReaders.has(key(relative, node)))
        scans.add(key(relative, node));
    }
    if (!ts.isCatchClause(node)) return;
    visitCatchBody(node.block, (child) => {
      const returnsCall =
        ts.isReturnStatement(child) && child.expression !== undefined && ts.isCallExpression(child.expression);
      const assignsCall =
        ts.isBinaryExpression(child) &&
        child.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isCallExpression(child.right);
      if (returnsCall || assignsCall) substitutions.add(key(relative, node));
    });
  });
}

function splitKey(value) {
  const separator = value.lastIndexOf("#");
  return { file: value.slice(0, separator), function: value.slice(separator + 1) };
}

function entriesFor(keys, extra) {
  return [...keys].sort().map((value) => ({ ...splitKey(value), ...extra }));
}

function formatDocument(document) {
  const lines = [
    "{",
    `  "schema": ${JSON.stringify(document.schema)},`,
    `  "gateId": ${JSON.stringify(document.gateId)},`,
    `  "baseline": ${JSON.stringify(document.baseline)},`,
    '  "entries": {',
  ];
  const sections = Object.entries(document.entries);
  for (const [sectionIndex, [name, entries]] of sections.entries()) {
    lines.push(`    ${JSON.stringify(name)}: [`);
    for (const [entryIndex, entry] of entries.entries()) {
      lines.push(`      ${JSON.stringify(entry)}${entryIndex === entries.length - 1 ? "" : ","}`);
    }
    lines.push(`    ]${sectionIndex === sections.length - 1 ? "" : ","}`);
  }
  lines.push("  }", "}", "");
  return lines.join("\n");
}

if (update) {
  const document = {
    schema: "harness-anything/gate-allowlist/v1",
    gateId,
    baseline:
      "Existing CH4 fallback exits are ratcheted here; remove a key when the corresponding production exit is deleted.",
    entries: {
      consumeKnownError: [...consume].sort(),
      fullHistoryScans: entriesFor(scans, {
        task: "task_403e958e3fefd3496820e8843d",
        reason: "Existing request-path historical scan pending a bounded-read deletion task.",
      }),
      catchSubstitutions: [...substitutions].sort(),
    },
  };
  await writeFile(path.join(root, allowlistPath), formatDocument(document));
}

const document = JSON.parse(await readFile(path.join(root, allowlistPath), "utf8"));
const consumeEntries = document?.entries?.consumeKnownError;
if (
  !Array.isArray(consumeEntries) ||
  consumeEntries.some((entry) => typeof entry !== "string" || !entry.includes("#"))
) {
  throw new Error("entries.consumeKnownError must contain file#function keys");
}
const scanEntries = loadEntries(document, "fullHistoryScans", ["file", "function", "task", "reason"]);
const substitutionEntries = document?.entries?.catchSubstitutions;
if (
  !Array.isArray(substitutionEntries) ||
  substitutionEntries.some((entry) => typeof entry !== "string" || !entry.includes("#"))
) {
  throw new Error("entries.catchSubstitutions must contain file#function keys");
}
const keyOf = (entry) => (typeof entry === "string" ? entry : `${entry.file}#${entry.function}`);
exactSync(consume, consumeEntries, keyOf, allowlistPath);
exactSync(scans, scanEntries, keyOf, allowlistPath);
exactSync(substitutions, substitutionEntries, keyOf, allowlistPath);
console.log(
  `${gateId}: consumeKnownError=${consume.size} fullHistoryScans=${scans.size} catchSubstitutions=${substitutions.size}`,
);
