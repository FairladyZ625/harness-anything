#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { blankedCliTestEnvKeys } from "../packages/cli/test/helpers/cli-test-env.ts";

const defaultRepoRoot = path.resolve(import.meta.dirname, "..");
const childProcessCalls = new Set(["execFileSync", "execSync", "spawnSync", "spawn", "execFile", "exec", "fork"]);
const sourceFilePattern = /\.(?:c|m)?js$|\.tsx?$/u;

export function checkCliTestEnv(repoRoot = defaultRepoRoot) {
  const violations = [];
  for (const filePath of cliTestSourceFiles(repoRoot)) {
    const relativePath = path.relative(repoRoot, filePath).split(path.sep).join("/");
    if (relativePath.endsWith("/helpers/cli-test-env.ts")) continue;
    const source = readFileSync(filePath, "utf8");
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
    const cliEntryBindings = findCliEntryBindings(sourceFile);
    visit(sourceFile, (node) => {
      if (ts.isCallExpression(node)) {
        const callName = node.expression.getText(sourceFile).split(".").at(-1);
        if (childProcessCalls.has(callName) && node.arguments.some((argument) => referencesCliEntry(argument, sourceFile, cliEntryBindings))) {
          const options = node.arguments.find(ts.isObjectLiteralExpression);
          const envProperty = options?.properties.find((property) =>
            ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === "env"
          );
          if (envProperty !== undefined && containsProcessEnv(envProperty.initializer, sourceFile)) {
            violations.push(violation(relativePath, sourceFile, envProperty, "CLI subprocess env reads process.env directly; use cliTestEnv(...)"));
          }
        }
      }
      if (ts.isPropertyAssignment(node) && blankedCliTestEnvKeys.includes(propertyName(node.name, sourceFile))) {
        if (ts.isStringLiteral(node.initializer) && node.initializer.text === "") {
          violations.push(violation(relativePath, sourceFile, node, "inline session blank duplicates cliTestEnv authority"));
        }
      }
    });
  }
  return violations.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
}

export function formatCliTestEnvReport(violations) {
  if (violations.length === 0) return "CLI test env check passed: all discovered CLI subprocess env sites use the shared authority.";
  return [
    "CLI test env check failed.",
    ...violations.map((entry) => `- ${entry.path}:${entry.line}: ${entry.message}`)
  ].join("\n");
}

export function main(repoRoot = defaultRepoRoot) {
  const violations = checkCliTestEnv(repoRoot);
  console.log(formatCliTestEnvReport(violations));
  return violations.length === 0 ? 0 : 1;
}

function cliTestSourceFiles(repoRoot) {
  const packagesRoot = path.join(repoRoot, "packages");
  if (!existsSync(packagesRoot)) return [];
  const files = [];
  for (const packageEntry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!packageEntry.isDirectory()) continue;
    collectSourceFiles(path.join(packagesRoot, packageEntry.name, "test"), files);
  }
  return files.sort();
}

function collectSourceFiles(directory, files) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) collectSourceFiles(target, files);
    else if (sourceFilePattern.test(entry.name)) files.push(target);
  }
}

function visit(node, inspect) {
  inspect(node);
  ts.forEachChild(node, (child) => visit(child, inspect));
}

function containsProcessEnv(node, sourceFile) {
  let found = false;
  visit(node, (child) => {
    if (ts.isPropertyAccessExpression(child) && child.getText(sourceFile) === "process.env") found = true;
  });
  return found;
}

function findCliEntryBindings(sourceFile) {
  const bindings = new Set(["cliEntry"]);
  let changed = true;
  while (changed) {
    changed = false;
    visit(sourceFile, (node) => {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.initializer === undefined) return;
      if (referencesCliEntry(node.initializer, sourceFile, bindings) && !bindings.has(node.name.text)) {
        bindings.add(node.name.text);
        changed = true;
      }
    });
  }
  return bindings;
}

function referencesCliEntry(node, sourceFile, bindings) {
  let found = false;
  visit(node, (child) => {
    if (ts.isIdentifier(child) && bindings.has(child.text)) found = true;
    if (ts.isStringLiteral(child) && /(?:packages\/cli\/src|\.\.\/src)\/index\.ts$/u.test(child.text)) found = true;
  });
  return found;
}

function propertyName(name, sourceFile) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText(sourceFile);
}

function violation(pathname, sourceFile, node, message) {
  return { path: pathname, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, message };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
