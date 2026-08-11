#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { entryValues, loadGateAllowlist } from "./gate-allowlists/load-gate-allowlist.mjs";

const targetRoots = [
  "packages/kernel/src/store",
  "packages/kernel/src/local",
  "packages/adapters/local/src",
  "packages/cli/src/commands"
];

const fsWriteApis = new Set([
  "appendFile", "appendFileSync", "closeSync", "copyFile", "copyFileSync", "cp", "cpSync",
  "fsyncSync", "mkdir", "mkdirSync", "open", "openSync", "rename", "renameSync", "rm",
  "rmSync", "rmdir", "rmdirSync", "symlink", "symlinkSync", "truncate", "truncateSync",
  "unlink", "unlinkSync", "write", "writeFile", "writeFileSync", "writeSync"
]);

export function scanBypassWriteCalls(root = process.cwd()) {
  return targetRoots.flatMap((relRoot) => walkTypeScriptFiles(root, relRoot)).flatMap((rel) => inspectFile(root, rel));
}

export function checkBypassWriteBoundary(root = process.cwd()) {
  const allowlist = loadGateAllowlist("check-bypass-write-boundary", {
    requiredSections: ["coordinatedCore", "exemptHumanOrBootstrap", "legacyArchive", "freshGateRegistry"]
  });
  const allowed = new Set(Object.values(allowlist).flatMap((entries) => entryValues(entries)));
  const findings = scanBypassWriteCalls(root).map((finding) => ({
    ...finding,
    message: `${finding.api} writes filesystem state outside the coordinator unless explicitly governed`,
    allowed: allowed.has(finding.key)
  }));

  for (const entry of allowed) {
    if (!findings.some((finding) => finding.key === entry)) {
      findings.push({ key: entry, message: `allowlist entry is stale and should be removed: ${entry}`, allowed: false });
    }
  }
  return { findings, violations: findings.filter((finding) => !finding.allowed) };
}

function inspectFile(root, rel) {
  const sourceText = readFileSync(path.join(root, rel), "utf8");
  const sourceFile = ts.createSourceFile(rel, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bindings = fsBindings(sourceFile);
  const sqlite = sqliteBindings(sourceFile);
  const sqliteWritable = hasWritableSqliteOpen(sourceFile, sqlite);
  if (bindings.named.size === 0 && bindings.namespaces.size === 0 && sqlite.size === 0) return [];
  const occurrences = new Map();
  const findings = [];

  visit(sourceFile, (node) => {
    const api = ts.isCallExpression(node) ? calledFsApi(node.expression, bindings) ?? calledSqliteApi(node.expression, sqlite, sqliteWritable)
      : ts.isNewExpression(node) && ts.isIdentifier(node.expression) && sqlite.has(node.expression.text) && !readOnlySqliteOpen(node) ? "DatabaseSync" : undefined;
    if (!api) return;
    const occurrence = (occurrences.get(api) ?? 0) + 1;
    occurrences.set(api, occurrence);
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.expression.getStart(sourceFile));
    findings.push({
      api,
      key: `${rel}#${api}@${occurrence}`,
      legacyKey: `${rel}#${api}@${line + 1}:${character + 1}`
    });
  });
  return findings;
}

function sqliteBindings(sourceFile) {
  const bindings = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "node:sqlite") continue;
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      if ((element.propertyName ?? element.name).text === "DatabaseSync") bindings.add(element.name.text);
    }
  }
  return bindings;
}

function calledSqliteApi(expression, sqlite, sqliteWritable) {
  if (!sqliteWritable || sqlite.size === 0 || !ts.isPropertyAccessExpression(expression)) return undefined;
  return ["exec", "prepare"].includes(expression.name.text) ? `sqlite.${expression.name.text}` : undefined;
}

function hasWritableSqliteOpen(sourceFile, sqlite) {
  let writable = false;
  visit(sourceFile, (node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && sqlite.has(node.expression.text) && !readOnlySqliteOpen(node)) writable = true;
  });
  return writable;
}

function readOnlySqliteOpen(node) {
  const options = node.arguments?.[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some((property) => ts.isPropertyAssignment(property)
    && property.name.getText() === "readOnly" && property.initializer.kind === ts.SyntaxKind.TrueKeyword);
}

function fsBindings(sourceFile) {
  const named = new Map();
  const namespaces = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!["node:fs", "node:fs/promises"].includes(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) namespaces.add(clause.name.text);
    const namedBindings = clause.namedBindings;
    if (namedBindings && ts.isNamespaceImport(namedBindings)) namespaces.add(namedBindings.name.text);
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (fsWriteApis.has(imported)) named.set(element.name.text, imported);
      }
    }
  }
  return { named, namespaces };
}

function calledFsApi(expression, bindings) {
  if (ts.isIdentifier(expression)) return bindings.named.get(expression.text);
  if (!ts.isPropertyAccessExpression(expression) || !bindings.namespaces.has(expression.expression.getText())) return undefined;
  return fsWriteApis.has(expression.name.text) ? expression.name.text : undefined;
}

function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function walkTypeScriptFiles(root, relRoot) {
  const absRoot = path.join(root, relRoot);
  if (!existsSync(absRoot)) return [];
  return ts.sys.readDirectory(absRoot, [".ts"], undefined, undefined)
    .filter((entry) => statSync(entry).isFile() && !entry.endsWith(".d.ts"))
    .map((entry) => path.relative(root, entry).split(path.sep).join("/"))
    .sort();
}

function main() {
  const result = checkBypassWriteBoundary();
  if (result.violations.length > 0) {
    console.error("Bypass write boundary check failed:");
    for (const finding of result.violations) console.error(`- ${finding.key}: ${finding.message}`);
    process.exitCode = 1;
  } else {
    console.log(`Bypass write boundary check passed (${result.findings.length} governed filesystem/SQLite call(s)).`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
