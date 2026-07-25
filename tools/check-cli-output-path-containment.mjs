#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { fsWriteApis } from "./fs-write-apis.mjs";

const sourceRoot = "packages/cli/src";
const ignoredPrefix = "packages/cli/src/commands/extensions/assets/";
const outputFlags = /^--(?:out(?:put)?(?:-.+)?|report)$/u;
const containmentResolvers = new Set(["resolveContainedOutputPath", "requireDaemonProductOutputPath"]);
const destinationArgument = new Map([
  ["copyFile", 1],
  ["copyFileSync", 1],
  ["cp", 1],
  ["cpSync", 1],
  ["rename", 1],
  ["renameSync", 1]
]);

export function checkCliOutputPathContainment(root = process.cwd()) {
  const files = walkSourceFiles(root);
  const parsed = files.map((rel) => ({ rel, sourceFile: parseSource(root, rel) }));
  const outputProperties = discoverOutputProperties(parsed);
  const findings = parsed.flatMap(({ rel, sourceFile }) => inspectFile(rel, sourceFile, outputProperties));
  const unique = new Map(findings.map((finding) => [`${finding.file}:${finding.line}:${finding.column}`, finding]));
  return { violations: [...unique.values()].sort(compareFindings) };
}

function discoverOutputProperties(parsed) {
  const properties = new Set();
  for (const { sourceFile } of parsed) {
    visit(sourceFile, (node) => {
      if (!ts.isPropertyAssignment(node) || !containsOutputOptionRead(node.initializer)) return;
      const name = propertyName(node.name);
      if (name) properties.add(name);
    });
  }
  return properties;
}

function containsOutputOptionRead(node) {
  let found = false;
  const inspect = (candidate) => {
    if (found) return;
    if (candidate !== node && (ts.isObjectLiteralExpression(candidate) || ts.isPropertyAssignment(candidate))) return;
    if (ts.isCallExpression(candidate) && calledName(candidate.expression) === "readOption") {
      const flag = candidate.arguments[1];
      if (flag && ts.isStringLiteral(flag) && outputFlags.test(flag.text)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(candidate, inspect);
  };
  inspect(node);
  return found;
}

function inspectFile(rel, sourceFile, outputProperties) {
  const fsImports = fsBindings(sourceFile);
  const findings = [];
  const functions = functionsIn(sourceFile);
  const namedFunctions = new Map(functions.flatMap((fn) => functionName(fn) ? [[functionName(fn), fn]] : []));
  const taintedParameters = new Map(functions.map((fn) => [fn, new Set()]));
  let propagated = true;
  let analyses = new Map();
  while (propagated) {
    propagated = false;
    analyses = new Map(functions.map((fn) => [fn, analyzeFunction(fn, taintedParameters.get(fn), outputProperties)]));
    for (const fn of functions) {
      const analysis = analyses.get(fn);
      visit(fn.body, (node) => {
        if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
        const callee = namedFunctions.get(node.expression.text);
        if (!callee) return;
        const marked = taintedParameters.get(callee);
        node.arguments.forEach((argument, index) => {
          if (isTaintedExpression(argument, analysis.tainted, outputProperties, analysis.sanitized) && !marked.has(index)) {
            marked.add(index);
            propagated = true;
          }
        });
      });
    }
  }
  for (const fn of functions) {
    const { tainted, sanitized } = analyses.get(fn);
    visit(fn.body, (node) => {
      if (!ts.isCallExpression(node)) return;
      const api = calledFsApi(node.expression, fsImports);
      if (!api) return;
      const target = node.arguments[destinationArgument.get(api) ?? 0];
      if (!target || !isTaintedExpression(target, tainted, outputProperties, sanitized)) return;
      findings.push(finding(rel, node.expression, sourceFile, api));
    });
  }
  return findings;
}

function analyzeFunction(fn, taintedParameterIndexes, outputProperties) {
  const tainted = new Set();
  fn.parameters.forEach((parameter, index) => {
    if (taintedParameterIndexes.has(index) && ts.isIdentifier(parameter.name)) tainted.add(parameter.name.text);
  });
    const sanitized = new Set();
    let changed = true;
    while (changed) {
      changed = false;
      visit(fn.body, (node) => {
        if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
        if (isSanitizedExpression(node.initializer, sanitized)) {
          if (!sanitized.has(node.name.text)) {
            sanitized.add(node.name.text);
            changed = true;
          }
          return;
        }
        if (isTaintedExpression(node.initializer, tainted, outputProperties, sanitized) && !tainted.has(node.name.text)) {
          tainted.add(node.name.text);
          changed = true;
        }
      });
    }
  return { tainted, sanitized };
}

function isTaintedExpression(node, tainted, outputProperties, sanitized) {
  if (isSanitizedExpression(node, sanitized)) return false;
  if (ts.isIdentifier(node)) return tainted.has(node.text) && !sanitized.has(node.text);
  if (ts.isPropertyAccessExpression(node) && outputProperties.has(node.name.text)) return true;
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)
    && outputProperties.has(node.argumentExpression.text)) return true;
  if (ts.isCallExpression(node) && calledName(node.expression) === "readOption") {
    const flag = node.arguments[1];
    return Boolean(flag && ts.isStringLiteral(flag) && outputFlags.test(flag.text));
  }
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && isTaintedExpression(child, tainted, outputProperties, sanitized)) found = true;
  });
  return found;
}

function isSanitizedExpression(node, sanitized) {
  if (ts.isCallExpression(node) && containmentResolvers.has(calledName(node.expression))) return true;
  return ts.isPropertyAccessExpression(node)
    && node.name.text === "path"
    && ts.isIdentifier(node.expression)
    && sanitized.has(node.expression.text);
}

function functionsIn(sourceFile) {
  const functions = [];
  visit(sourceFile, (node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) && node.body) {
      functions.push(node);
    }
  });
  return functions;
}

function functionName(fn) {
  if ("name" in fn && fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) {
    return fn.parent.name.text;
  }
  return undefined;
}

function fsBindings(sourceFile) {
  const named = new Map();
  const namespaces = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!["node:fs", "node:fs/promises"].includes(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
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

function calledName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function walkSourceFiles(root) {
  const absolute = path.join(root, sourceRoot);
  if (!existsSync(absolute)) return [];
  return ts.sys.readDirectory(absolute, [".ts", ".mts", ".cts"], undefined, undefined)
    .filter((entry) => statSync(entry).isFile() && !entry.endsWith(".d.ts"))
    .map((entry) => path.relative(root, entry).split(path.sep).join("/"))
    .filter((entry) => !entry.startsWith(ignoredPrefix))
    .sort();
}

function parseSource(root, rel) {
  const text = readFileSync(path.join(root, rel), "utf8");
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function finding(file, node, sourceFile, api) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    file,
    line: line + 1,
    column: character + 1,
    message: `${api} receives a user-controlled output path without resolveContainedOutputPath`
  };
}

function propertyName(name) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

function compareFindings(left, right) {
  return left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column;
}

function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function main() {
  const rootFlag = process.argv.indexOf("--root");
  const root = rootFlag >= 0 && process.argv[rootFlag + 1] ? path.resolve(process.argv[rootFlag + 1]) : process.cwd();
  const result = checkCliOutputPathContainment(root);
  if (result.violations.length > 0) {
    console.error("CLI output-path containment check failed:");
    for (const violation of result.violations) {
      console.error(`- ${violation.file}:${violation.line}:${violation.column} ${violation.message}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("CLI output-path containment check passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
