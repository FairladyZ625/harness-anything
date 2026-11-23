#!/usr/bin/env node
/**
 * Static anti-regression gate for Windows Issue #4477.
 *
 * Scans `packages/<pkg>/test/**\/*.{ts,tsx,js,mjs}` and rejects bare recursive
 * `rmSync(..., { ...recursive: true... })` calls. Tests must use
 * `removeTempRepository(...)` from `tools/fixtures/remove-temp-repository.ts`
 * so in-process SQLite handles are closed and Windows transient EPERM/EBUSY
 * errors are retried cleanly.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const DEFAULT_ROOT = process.cwd();
const TEST_FILE_PATTERN = /\.(?:ts|tsx|js|mjs)$/u;

function walkTestFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTestFiles(fullPath, out);
    } else if (TEST_FILE_PATTERN.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

function bareRecursiveRmSyncViolation(node, sf, relPath) {
  if (!ts.isCallExpression(node) || node.arguments.length < 2) return null;
  const expr = node.expression;
  const calleeName = ts.isIdentifier(expr)
    ? expr.text
    : ts.isPropertyAccessExpression(expr)
      ? expr.name.text
      : ts.isElementAccessExpression(expr) && ts.isStringLiteralLike(expr.argumentExpression)
        ? expr.argumentExpression.text
        : null;
  if (calleeName !== "rmSync") return null;
  const optionsArg = node.arguments[1];
  if (!optionsArg || !ts.isObjectLiteralExpression(optionsArg)) return null;
  const recursiveProp = optionsArg.properties.find((prop) => {
    if (!ts.isPropertyAssignment(prop)) return false;
    const name = ts.isIdentifier(prop.name)
      ? prop.name.text
      : ts.isStringLiteralLike(prop.name)
        ? prop.name.text
        : null;
    return name === "recursive" && prop.initializer.kind === ts.SyntaxKind.TrueKeyword;
  });
  if (!recursiveProp) return null;
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return `${relPath}:${line + 1}:${character + 1}: bare recursive rmSync(...) is forbidden in tests; use removeTempRepository(...) from tools/fixtures/remove-temp-repository.ts`;
}

export function checkTestTempCleanup(root = DEFAULT_ROOT) {
  const packagesDir = path.join(root, "packages");
  const findings = [];
  let filesScanned = 0;

  if (existsSync(packagesDir)) {
    const packages = readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const pkg of packages) {
      const testDir = path.join(packagesDir, pkg, "test");
      if (!existsSync(testDir)) continue;
      for (const filePath of walkTestFiles(testDir).sort()) {
        filesScanned += 1;
        const source = readFileSync(filePath, "utf8");
        if (!source.includes("rmSync")) continue;
        const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
        const relPath = path.relative(root, filePath).split(path.sep).join("/");

        const visit = (node) => {
          const violation = bareRecursiveRmSyncViolation(node, sf, relPath);
          if (violation !== null) findings.push(violation);
          ts.forEachChild(node, visit);
        };
        visit(sf);
      }
    }
  }

  return {
    ok: findings.length === 0,
    findings,
    counts: {
      filesScanned,
      violations: findings.length,
    },
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const rootArg = process.argv[2];
  const result = checkTestTempCleanup(rootArg ? path.resolve(rootArg) : DEFAULT_ROOT);
  if (!result.ok) {
    console.error(`Test temp cleanup check failed (${result.counts.violations} violation(s)):`);
    for (const finding of result.findings) {
      console.error(`  - ${finding}`);
    }
    process.exit(1);
  }
  console.log(`Test temp cleanup check passed (${result.counts.filesScanned} test files scanned, 0 violations).`);
}
