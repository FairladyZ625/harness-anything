#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { childProcessApis } from "./child-process-apis.mjs";
import { fsWriteApis } from "./fs-write-apis.mjs";
import { entryValues, loadGateAllowlist } from "./gate-allowlists/load-gate-allowlist.mjs";
import { discoverWorkspaceSourceRoots } from "./workspace-packages.mjs";

export function scanBypassWriteCalls(root = process.cwd()) {
  const targetRoots = [...discoverWorkspaceSourceRoots(root), "tools"];
  return targetRoots.flatMap((relRoot) => walkProductionSourceFiles(root, relRoot)).flatMap((rel) => inspectFile(root, rel));
}

export function checkBypassWriteBoundary(root = process.cwd()) {
  const allowlist = loadGateAllowlist("check-bypass-write-boundary", {
    requiredSections: ["coordinatedCore", "exemptHumanOrBootstrap", "legacyArchive", "freshGateRegistry", "omissionDebt"],
    ratchetSections: ["omissionDebt"]
  });
  const allowed = new Set(Object.values(allowlist).flatMap((entries) => entryValues(entries)));
  const findings = scanBypassWriteCalls(root).map((finding) => ({
    ...finding,
    message: `${finding.api} mutates filesystem or process state outside the coordinator unless explicitly governed`,
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
  const sourceFile = ts.createSourceFile(rel, sourceText, ts.ScriptTarget.Latest, true, scriptKind(rel));
  const bindings = mutatingBindings(sourceFile);
  if (bindings.named.size === 0 && bindings.namespaces.size === 0) return [];
  const occurrences = new Map();
  const findings = [];

  visit(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const api = calledMutatingApi(node.expression, bindings);
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

function mutatingBindings(sourceFile) {
  const named = new Map();
  const namespaces = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const moduleKind = moduleBindingKind(statement.moduleSpecifier.text);
      if (!moduleKind) continue;
      const clause = statement.importClause;
      if (!clause) continue;
      if (clause.name) namespaces.set(clause.name.text, moduleKind);
      const namedBindings = clause.namedBindings;
      if (namedBindings && ts.isNamespaceImport(namedBindings)) namespaces.set(namedBindings.name.text, moduleKind);
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (apisFor(moduleKind).has(imported)) named.set(element.name.text, imported);
        }
      }
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const moduleKind = requiredModuleKind(declaration.initializer);
      if (!moduleKind) continue;
      if (ts.isIdentifier(declaration.name)) namespaces.set(declaration.name.text, moduleKind);
      if (ts.isObjectBindingPattern(declaration.name)) {
        for (const element of declaration.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const imported = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
          if (apisFor(moduleKind).has(imported)) named.set(element.name.text, imported);
        }
      }
    }
  }
  return { named, namespaces };
}

function calledMutatingApi(expression, bindings) {
  if (ts.isIdentifier(expression)) return bindings.named.get(expression.text);
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  if (ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "promises") {
    const kind = bindings.namespaces.get(expression.expression.expression.getText());
    return kind === "fs" && fsWriteApis.has(expression.name.text) ? expression.name.text : undefined;
  }
  const kind = bindings.namespaces.get(expression.expression.getText());
  return kind && apisFor(kind).has(expression.name.text) ? expression.name.text : undefined;
}

function moduleBindingKind(moduleName) {
  if (["fs", "fs/promises", "node:fs", "node:fs/promises"].includes(moduleName)) return "fs";
  if (moduleName === "child_process" || moduleName === "node:child_process") return "process";
  return undefined;
}

function requiredModuleKind(initializer) {
  if (!initializer || !ts.isCallExpression(initializer) || !ts.isIdentifier(initializer.expression) || initializer.expression.text !== "require") return undefined;
  const moduleName = initializer.arguments[0];
  return moduleName && ts.isStringLiteralLike(moduleName) ? moduleBindingKind(moduleName.text) : undefined;
}

function apisFor(kind) {
  return kind === "fs" ? fsWriteApis : childProcessApis;
}

function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function walkProductionSourceFiles(root, relRoot) {
  const absRoot = path.join(root, relRoot);
  if (!existsSync(absRoot)) return [];
  return ts.sys.readDirectory(absRoot, [".ts", ".tsx", ".js", ".mjs", ".cjs"], ["**/node_modules/**"], undefined)
    .filter((entry) => statSync(entry).isFile() && isProductionSource(entry))
    .map((entry) => path.relative(root, entry).split(path.sep).join("/"))
    .sort();
}

function isProductionSource(entry) {
  const normalized = entry.split(path.sep).join("/");
  return !normalized.endsWith(".d.ts") &&
    !/(?:^|\/)(?:fixtures?|test-fixtures)(?:\/|$)/u.test(normalized) &&
    !/(?:^|\.)test\.[^/]+$/u.test(normalized);
}

function scriptKind(rel) {
  if (rel.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (rel.endsWith(".ts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function main() {
  const result = checkBypassWriteBoundary();
  if (result.violations.length > 0) {
    console.error("Bypass write boundary check failed:");
    for (const finding of result.violations) console.error(`- ${finding.key}: ${finding.message}`);
    process.exitCode = 1;
  } else {
    console.log(`Bypass write boundary check passed (${result.findings.length} governed filesystem/process mutation call(s)).`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
