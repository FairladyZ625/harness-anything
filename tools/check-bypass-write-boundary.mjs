#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { entryValues, loadGateAllowlist } from "./gate-allowlists/load-gate-allowlist.mjs";

const targetRoots = [
  "packages/kernel/src/store",
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
  if (bindings.named.size === 0 && bindings.namespaces.size === 0) return [];
  const occurrences = new Map();
  const findings = [];

  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const api = calledFsApi(node.expression, bindings);
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
    console.log(`Bypass write boundary check passed (${result.findings.length} governed fs write call(s)).`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
