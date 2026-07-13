// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { makeLocalVersionControlSystem, localGitProcessOptions } from "../../src/store/local-version-control-system.ts";
import { VcsCommandError } from "../../src/ports/version-control-system.ts";

test("local Git subprocesses stay hidden on Windows while preserving captured output", () => {
  const options = localGitProcessOptions();

  assert.equal(options.windowsHide, true);
  assert.equal(options.encoding, "utf8");
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
});

test("local Git execution preserves captured output and typed command errors", () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "ha-hidden-git-"));
  const nonRepoRoot = mkdtempSync(path.join(tmpdir(), "ha-hidden-git-error-"));
  try {
    execFileSync("git", ["-C", repoRoot, "init", "-b", "hidden-window-test"], { stdio: "ignore" });
    execFileSync("git", [
      "-C", repoRoot,
      "-c", "user.name=Harness Test",
      "-c", "user.email=harness@example.test",
      "commit", "--allow-empty", "-m", "seed"
    ], { stdio: "ignore" });
    const vcs = makeLocalVersionControlSystem();

    assert.equal(vcs.currentBranch(repoRoot), "hidden-window-test");
    assert.throws(
      () => vcs.commit(nonRepoRoot, "must fail"),
      (error: unknown) => error instanceof VcsCommandError
        && error.command === "commit"
        && error.cwd === nonRepoRoot
        && typeof error.stderrSummary === "string"
        && error.stderrSummary.length > 0
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(nonRepoRoot, { recursive: true, force: true });
  }
});

test("every production Git subprocess explicitly hides its Windows window", () => {
  const repoRoot = path.resolve(import.meta.dirname, "../../../..");
  const sourceFiles = typescriptFiles(path.join(repoRoot, "packages"), repoRoot);
  const missing = sourceFiles.flatMap((file) => missingWindowsHideCalls(repoRoot, file));

  assert.deepEqual(missing, []);
});

function typescriptFiles(directory: string, repoRoot: string): ReadonlyArray<string> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "test" || entry.name === "dist" ? [] : typescriptFiles(entryPath, repoRoot);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path.relative(repoRoot, entryPath)] : [];
  });
}

function missingWindowsHideCalls(repoRoot: string, relativePath: string): ReadonlyArray<string> {
  const sourceText = readFileSync(path.join(repoRoot, relativePath), "utf8");
  const sourceFile = ts.createSourceFile(relativePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const missing: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "execFileSync"
      && node.arguments[0]?.getText(sourceFile) === '"git"') {
      const options = node.arguments[2];
      const usesContract = options?.getText(sourceFile).startsWith("localGitProcessOptions(") ?? false;
      const hidesWindow = options && ts.isObjectLiteralExpression(options) && options.properties.some((property) =>
        ts.isPropertyAssignment(property)
        && property.name.getText(sourceFile) === "windowsHide"
        && property.initializer.kind === ts.SyntaxKind.TrueKeyword
      );
      if (!usesContract && !hidesWindow) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        missing.push(`${relativePath}:${line}`);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return missing;
}
