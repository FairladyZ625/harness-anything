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

function isRmSyncCallee(expr) {
  if (ts.isIdentifier(expr)) return expr.text === "rmSync";
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text === "rmSync";
  if (ts.isElementAccessExpression(expr) && ts.isStringLiteralLike(expr.argumentExpression)) {
    return expr.argumentExpression.text === "rmSync";
  }
  return false;
}

function hasRecursiveTrueOption(arg) {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
  for (const prop of arg.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = ts.isIdentifier(prop.name)
      ? prop.name.text
      : ts.isStringLiteralLike(prop.name)
        ? prop.name.text
        : null;
    if (name === "recursive" && prop.initializer.kind === ts.SyntaxKind.TrueKeyword) {
      return true;
    }
  }
  return false;
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
          if (ts.isCallExpression(node) && isRmSyncCallee(node.expression)) {
            if (node.arguments.length >= 2 && hasRecursiveTrueOption(node.arguments[1])) {
              const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
              findings.push(
                `${relPath}:${line + 1}:${character + 1}: bare recursive rmSync(...) is forbidden in tests; use removeTempRepository(...) from tools/fixtures/remove-temp-repository.ts`,
              );
            }
          }
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
