#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { entryValues, loadGateAllowlist } from "./gate-allowlists/load-gate-allowlist.mjs";

// Governance: W8 task_01KWW58383X74ZK28Y068CQ2TG closes bypass write channels
// under dec_mr9acuxm. This is an AST gate per dec_GATE_DEFENSE_ROOT_CAUSE:
// new fs write calls in kernel/adapters/cli authored or machine-read surfaces
// require an explicit allowlist entry or must route through WriteCoordinator.

const root = process.cwd();
const targetRoots = [
  "packages/kernel/src/store",
  "packages/adapters/local/src",
  "packages/cli/src/commands"
];

const fsWriteApis = new Set([
  "appendFile",
  "appendFileSync",
  "closeSync",
  "copyFile",
  "copyFileSync",
  "cp",
  "cpSync",
  "fsyncSync",
  "mkdir",
  "mkdirSync",
  "open",
  "openSync",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
  "symlink",
  "symlinkSync",
  "truncate",
  "truncateSync",
  "unlink",
  "unlinkSync",
  "write",
  "writeFile",
  "writeFileSync",
  "writeSync"
]);

const allowlist = loadGateAllowlist("check-bypass-write-boundary", {
  requiredSections: ["coordinatedCore", "exemptHumanOrBootstrap", "legacyArchive", "freshGateRegistry"]
});
const allowed = new Set(Object.values(allowlist).flatMap((entries) => entryValues(entries)));
const findings = [];

for (const rel of targetRoots.flatMap(walkTypeScriptFiles)) {
  inspectFile(rel);
}

const stale = [...allowed].filter((entry) => !findings.some((finding) => finding.key === entry));
for (const entry of stale) {
  findings.push({
    key: entry,
    message: `allowlist entry is stale and should be removed: ${entry}`,
    allowed: false
  });
}

const violations = findings.filter((finding) => !finding.allowed);
if (violations.length > 0) {
  console.error("Bypass write boundary check failed:");
  for (const finding of violations) {
    console.error(`- ${finding.key}: ${finding.message}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Bypass write boundary check passed (${findings.length} governed fs write call(s)).`);
}

function inspectFile(rel) {
  const abs = path.join(root, rel);
  const sourceText = readFileSync(abs, "utf8");
  const sourceFile = ts.createSourceFile(rel, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bindings = fsBindings(sourceFile);
  if (bindings.named.size === 0 && bindings.namespaces.size === 0) return;

  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const api = calledFsApi(node.expression, bindings);
    if (!api) return;
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.expression.getStart(sourceFile));
    const key = `${rel}#${api}@${line + 1}:${character + 1}`;
    findings.push({
      key,
      message: `${api} writes filesystem state outside the coordinator unless explicitly governed`,
      allowed: allowed.has(key)
    });
  });
}

function fsBindings(sourceFile) {
  const named = new Map();
  const namespaces = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== "node:fs" && statement.moduleSpecifier.text !== "node:fs/promises") continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) namespaces.add(clause.name.text);
    const namedBindings = clause.namedBindings;
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      namespaces.add(namedBindings.name.text);
    }
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
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  if (!bindings.namespaces.has(expression.expression.getText())) return undefined;
  const api = expression.name.text;
  return fsWriteApis.has(api) ? api : undefined;
}

function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function walkTypeScriptFiles(relRoot) {
  const absRoot = path.join(root, relRoot);
  if (!existsSync(absRoot)) return [];
  const out = [];
  const visitDir = (dir) => {
    for (const entry of ts.sys.readDirectory(dir, [".ts"], undefined, undefined)) {
      const stat = statSync(entry);
      if (stat.isFile() && !entry.endsWith(".d.ts")) {
        out.push(path.relative(root, entry).split(path.sep).join("/"));
      }
    }
  };
  visitDir(absRoot);
  return out.sort();
}
