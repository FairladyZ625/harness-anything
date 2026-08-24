#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { loadGateAllowlist } from "./gate-allowlists/load-gate-allowlist.mjs";
import { readSourceIdentity } from "./gate-allowlists/source-identity.mjs";

const gateId = "check-bypass-write-boundary";

const targetRoots = [
  "packages/kernel/src/store",
  "packages/kernel/src/local",
  "packages/kernel/src/projection",
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
  const allowlist = loadGateAllowlist(gateId, {
    requiredSections: ["coordinatedCore", "rebuildable-projection", "exemptHumanOrBootstrap", "legacyArchive", "freshGateRegistry"]
  });
  const rebuildableProjection = new Map(allowlist["rebuildable-projection"].map((entry) => [entry.value, entry]));
  const governed = new Map(Object.entries(allowlist)
    .filter(([section]) => section !== "rebuildable-projection")
    .flatMap(([, entries]) => entries)
    .map((entry) => [entry.value, entry]));
  const findings = scanBypassWriteCalls(root).map((finding) => {
    const entry = (finding.category === "rebuildable-projection" ? rebuildableProjection : governed).get(finding.key);
    return {
      ...finding,
      message: entry && entry.api !== finding.api
        ? `source identity ${finding.key} changed API from ${entry.api} to ${finding.api}`
        : finding.category === "rebuildable-projection"
          ? `${finding.api} writes a rebuildable projection cache under the explicit rebuildable-projection exemption`
          : `${finding.api} writes filesystem state outside the coordinator unless explicitly governed`,
      allowed: finding.identity !== null && entry?.api === finding.api
    };
  });

  const identityCounts = new Map();
  for (const finding of findings) {
    if (finding.identity !== null) identityCounts.set(finding.identity, (identityCounts.get(finding.identity) ?? 0) + 1);
  }
  for (const finding of findings) {
    if (finding.identity !== null && identityCounts.get(finding.identity) !== 1) {
      finding.allowed = false;
      finding.message = `source identity ${finding.identity} is attached to more than one governed call`;
    }
  }

  for (const entry of [...governed.values(), ...rebuildableProjection.values()]) {
    if (!findings.some((finding) => finding.identity === entry.value)) {
      findings.push({ key: entry.value, message: `allowlist entry is stale and should be removed: ${entry.value}`, allowed: false });
    }
  }
  return { findings, violations: findings.filter((finding) => !finding.allowed) };
}

function inspectFile(root, rel) {
  const sourceText = readFileSync(path.join(root, rel), "utf8");
  const category = rel.startsWith("packages/kernel/src/projection/")
    && sourceText.includes("@write-boundary-exemption rebuildable-projection") ? "rebuildable-projection" : "governed-write";
  const sourceFile = ts.createSourceFile(rel, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bindings = fsBindings(sourceFile);
  const sqlite = sqliteBindings(sourceFile);
  const sqliteGoverned = category === "rebuildable-projection" || hasWritableSqliteOpen(sourceFile, sqlite);
  if (bindings.named.size === 0 && bindings.namespaces.size === 0 && sqlite.size === 0) return [];
  const findings = [];

  visit(sourceFile, (node) => {
    const api = ts.isCallExpression(node) ? calledFsApi(node.expression, bindings) ?? calledSqliteApi(node.expression, sqlite, sqliteGoverned)
      : ts.isNewExpression(node) && ts.isIdentifier(node.expression) && sqlite.has(node.expression.text) && !readOnlySqliteOpen(node) ? "DatabaseSync" : undefined;
    if (!api) return;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.expression.getStart(sourceFile));
    const identity = readSourceIdentity(node.expression, sourceFile, gateId);
    findings.push({
      api,
      category,
      path: rel,
      line: line + 1,
      column: character + 1,
      identity,
      key: identity ?? `${rel}#${api}@${line + 1}:${character + 1}`,
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

function calledSqliteApi(expression, sqlite, sqliteGoverned) {
  if (!sqliteGoverned || sqlite.size === 0 || !ts.isPropertyAccessExpression(expression)) return undefined;
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
    for (const finding of result.violations) {
      const location = finding.path ? `${finding.path}:${finding.line}:${finding.column}` : finding.key;
      console.error(`- ${location} [${finding.key}]: ${finding.message}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`Bypass write boundary check passed (${result.findings.length} governed filesystem/SQLite call(s)).`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
