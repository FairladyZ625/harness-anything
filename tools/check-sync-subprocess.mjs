#!/usr/bin/env node
/**
 * daemon/kernel synchronous-subprocess ratchet.
 *
 * Authority: dec_7F0604B4D53637BB6FF9875C8B CH1. Only APIs acquired
 * from node:child_process are in scope; synchronous filesystem APIs are not.
 */
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { syncSubprocessBaseline } from "./gate-allowlists/sync-subprocess-baseline.mjs";

const SOURCE_ROOTS = ["packages/daemon/src", "packages/kernel/src"];
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;
const CHILD_PROCESS_MODULE = "node:child_process";
const SYNC_APIS = new Set(["execFileSync", "execSync", "spawnSync"]);

export function scanSyncSubprocess(root = process.cwd()) {
  const files = SOURCE_ROOTS.flatMap((directory) => walk(path.join(root, directory)));
  if (files.length === 0) return [];
  const program = ts.createProgram({
    rootNames: files,
    options: {
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext
    }
  });
  const checker = program.getTypeChecker();
  const sites = [];

  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    const relativePath = relative(root, file);
    const namedBindings = new Map();
    const namespaceBindings = new Set();
    const fileSites = [];
    const add = (node, kind, api) => {
      const point = source.getLineAndCharacterOfPosition(node.getStart(source));
      const content = node.getText(source).replaceAll("\r\n", "\n");
      const fingerprint = createHash("sha256").update(content).digest("hex");
      fileSites.push({
        path: relativePath,
        line: point.line + 1,
        column: point.character + 1,
        kind,
        api,
        scope: semanticScope(node, source),
        fingerprint,
        content
      });
    };

    const registerBindings = (node) => {
      if (ts.isImportDeclaration(node) && moduleName(node.moduleSpecifier) === CHILD_PROCESS_MODULE) {
        const clause = node.importClause;
        if (clause?.name) registerNamespace(checker, namespaceBindings, clause.name);
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          registerNamespace(checker, namespaceBindings, clause.namedBindings.name);
        } else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const specifier of clause.namedBindings.elements) {
            if (clause.isTypeOnly || specifier.isTypeOnly) continue;
            const imported = (specifier.propertyName ?? specifier.name).text;
            if (!SYNC_APIS.has(imported)) continue;
            registerNamed(checker, namedBindings, specifier.name, imported);
            add(specifier, "import", imported);
          }
        }
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
        && moduleName(node.moduleReference.expression) === CHILD_PROCESS_MODULE) {
        registerNamespace(checker, namespaceBindings, node.name);
      } else if (ts.isVariableDeclaration(node) && isChildProcessModuleExpression(node.initializer)) {
        if (ts.isIdentifier(node.name)) {
          registerNamespace(checker, namespaceBindings, node.name);
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const imported = bindingPropertyName(element);
            if (!imported || !SYNC_APIS.has(imported)) continue;
            registerNamed(checker, namedBindings, element.name, imported);
            add(element, "import", imported);
          }
        }
      } else if (ts.isExportDeclaration(node) && moduleName(node.moduleSpecifier) === CHILD_PROCESS_MODULE
        && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const specifier of node.exportClause.elements) {
          if (node.isTypeOnly || specifier.isTypeOnly) continue;
          const imported = (specifier.propertyName ?? specifier.name).text;
          if (SYNC_APIS.has(imported)) add(specifier, "export", imported);
        }
      }
      ts.forEachChild(node, registerBindings);
    };
    registerBindings(source);

    const visitCalls = (node) => {
      if (ts.isCallExpression(node)) {
        const api = resolvedSyncApi(node.expression, checker, namedBindings, namespaceBindings);
        if (api) add(node, "call", api);
      }
      ts.forEachChild(node, visitCalls);
    };
    visitCalls(source);

    const visitReferences = (node) => {
      if (ts.isIdentifier(node)) {
        const api = namedBindings.get(checker.getSymbolAtLocation(node));
        if (api && !isNamedBindingDeclaration(node) && !isDirectCallTarget(node)) add(node, "reference", api);
      } else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && !isDirectCallTarget(node)) {
        const api = resolvedSyncApi(node, checker, namedBindings, namespaceBindings);
        if (api) add(node, "reference", api);
      }
      ts.forEachChild(node, visitReferences);
    };
    visitReferences(source);

    const occurrences = new Map();
    for (const site of fileSites.sort((left, right) => left.line - right.line || left.column - right.column)) {
      const identity = `${site.path}::${site.scope}::${site.kind}::${site.fingerprint}`;
      const occurrence = (occurrences.get(identity) ?? 0) + 1;
      occurrences.set(identity, occurrence);
      sites.push({ ...site, key: `${identity}::${occurrence}` });
    }
  }
  return sites.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.column - right.column);
}

export function checkSyncSubprocess(sites, baseline = syncSubprocessBaseline) {
  const findings = [];
  const baselineByKey = new Map();
  for (const entry of baseline) {
    if (!entry || typeof entry.key !== "string") {
      findings.push(`invalid baseline entry ${JSON.stringify(entry)}`);
      continue;
    }
    if (baselineByKey.has(entry.key)) findings.push(`duplicate baseline key ${entry.key}`);
    baselineByKey.set(entry.key, entry);
  }
  const siteByKey = new Map(sites.map((site) => [site.key, site]));
  for (const site of sites) {
    if (!baselineByKey.has(site.key)) {
      findings.push(`${site.key}: new synchronous subprocess ${site.kind} (${site.api})`);
    }
  }
  for (const entry of baseline) {
    if (typeof entry?.key === "string" && !siteByKey.has(entry.key)) {
      findings.push(`${entry.key}: stale baseline entry; remove it rather than transferring the exemption`);
    }
  }
  return findings;
}

export function inventoryCounts(sites) {
  const counts = { total: sites.length, files: {}, kinds: {}, apis: {} };
  for (const site of sites) {
    counts.files[site.path] = (counts.files[site.path] ?? 0) + 1;
    counts.kinds[site.kind] = (counts.kinds[site.kind] ?? 0) + 1;
    counts.apis[site.api] = (counts.apis[site.api] ?? 0) + 1;
  }
  return counts;
}

function registerNamed(checker, bindings, name, api) {
  const symbol = checker.getSymbolAtLocation(name);
  if (symbol) bindings.set(symbol, api);
}

function registerNamespace(checker, bindings, name) {
  const symbol = checker.getSymbolAtLocation(name);
  if (symbol) bindings.add(symbol);
}

function resolvedSyncApi(expression, checker, namedBindings, namespaceBindings) {
  if (ts.isIdentifier(expression)) {
    return namedBindings.get(checker.getSymbolAtLocation(expression)) ?? null;
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
    && namespaceBindings.has(checker.getSymbolAtLocation(expression.expression)) && SYNC_APIS.has(expression.name.text)) {
    return expression.name.text;
  }
  if (ts.isPropertyAccessExpression(expression) && isChildProcessModuleExpression(expression.expression)
    && SYNC_APIS.has(expression.name.text)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && ts.isIdentifier(expression.expression)
    && namespaceBindings.has(checker.getSymbolAtLocation(expression.expression))
    && expression.argumentExpression && ts.isStringLiteralLike(expression.argumentExpression)
    && SYNC_APIS.has(expression.argumentExpression.text)) {
    return expression.argumentExpression.text;
  }
  if (ts.isElementAccessExpression(expression) && isChildProcessModuleExpression(expression.expression)
    && expression.argumentExpression && ts.isStringLiteralLike(expression.argumentExpression)
    && SYNC_APIS.has(expression.argumentExpression.text)) return expression.argumentExpression.text;
  return null;
}

function isChildProcessModuleExpression(node) {
  if (node && ts.isAwaitExpression(node)) return isChildProcessModuleExpression(node.expression);
  return Boolean(node && ts.isCallExpression(node)
    && (ts.isIdentifier(node.expression) && node.expression.text === "require" || node.expression.kind === ts.SyntaxKind.ImportKeyword)
    && node.arguments.length === 1
    && moduleName(node.arguments[0]) === CHILD_PROCESS_MODULE);
}

function isNamedBindingDeclaration(node) {
  return ts.isImportSpecifier(node.parent) && node.parent.name === node
    || ts.isBindingElement(node.parent) && node.parent.name === node;
}

function isDirectCallTarget(node) {
  return ts.isCallExpression(node.parent) && node.parent.expression === node;
}

function bindingPropertyName(element) {
  if (element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName))) return element.propertyName.text;
  return ts.isIdentifier(element.name) ? element.name.text : null;
}

function moduleName(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function semanticScope(node, source) {
  const segments = [];
  for (let current = node.parent; current && !ts.isSourceFile(current); current = current.parent) {
    if (ts.isVariableDeclaration(current) || ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)
      || ts.isClassDeclaration(current) || ts.isPropertyAssignment(current) || ts.isPropertyDeclaration(current)) {
      const name = stableName(current.name, source);
      if (name) segments.unshift(name);
    }
  }
  return segments.join(".") || "<module>";
}

function stableName(name, source) {
  if (!name) return "";
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(source).replace(/[^A-Za-z0-9_.-]+/gu, "-");
}

function relative(root, file) { return path.relative(root, file).split(path.sep).join("/"); }
function walk(directory) { const files = []; let entries; try { entries = readdirSync(directory, { withFileTypes: true }); } catch (error) { if (error?.code === "ENOENT") return files; throw error; } for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) { const full = path.join(directory, entry.name); if (entry.isDirectory()) { if (!["dist", "node_modules", "out"].includes(entry.name)) files.push(...walk(full)); } else if (SOURCE_FILE.test(entry.name)) files.push(full); } return files; }

function printBaseline(sites) {
  console.log("export const syncSubprocessBaseline = Object.freeze([");
  for (const site of sites) console.log(`  { key: ${JSON.stringify(site.key)} }, // ${site.api} ${site.kind} @ ${site.scope}`);
  console.log("]);");
}

function printInventory(sites) {
  for (const site of sites) console.log(`${site.path}:${site.line}:${site.column} [${site.kind}/${site.api}] @ ${site.scope}`);
}

async function main() {
  const sites = scanSyncSubprocess();
  if (process.argv.includes("--print-baseline")) { printBaseline(sites); return; }
  if (process.argv.includes("--print-inventory")) { printInventory(sites); return; }
  if (process.argv.includes("--report")) { console.log(JSON.stringify({ inventory: inventoryCounts(sites), baseline: syncSubprocessBaseline.length }, null, 2)); return; }
  const findings = checkSyncSubprocess(sites);
  if (findings.length > 0) {
    console.error("Synchronous subprocess check failed:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  const counts = inventoryCounts(sites);
  console.log(`Synchronous subprocess check passed (${counts.total} frozen sites across ${Object.keys(counts.files).length} files; ${counts.kinds.import ?? 0} imports, ${counts.kinds.call ?? 0} calls, ${counts.kinds.reference ?? 0} other references).`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
