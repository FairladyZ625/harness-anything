// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { makeLocalVersionControlSystem, localGitProcessOptions } from "../../src/persistence/git/local-version-control-system.ts";
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

test("local Git resolves bulk path membership from one literal commit subtree", () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "ha-bulk-git-membership-"));
  const relativeRoot = "ledger[1]/authority-attribution-events/v2";
  const presentPath = `${relativeRoot}/present file.jsonl`;
  const encodedPath = `${relativeRoot}/${process.platform === "win32" ? "unicodé path" : "unicodé\nline"}.jsonl`;
  const unexpectedPath = `${relativeRoot}/unexpected.jsonl`;
  const missingPath = `${relativeRoot}/missing.jsonl`;
  const outsidePath = "ledger1/authority-attribution-events/v2/glob-match.jsonl";
  try {
    mkdirSync(path.join(repoRoot, relativeRoot), { recursive: true });
    mkdirSync(path.dirname(path.join(repoRoot, outsidePath)), { recursive: true });
    writeFileSync(path.join(repoRoot, presentPath), "present\n");
    writeFileSync(path.join(repoRoot, encodedPath), "encoded\n");
    writeFileSync(path.join(repoRoot, unexpectedPath), "unexpected\n");
    writeFileSync(path.join(repoRoot, outsidePath), "outside\n");
    fixtureGit(repoRoot, "init", "-b", "bulk-membership-test");
    fixtureGit(repoRoot, "add", "-f", "--", presentPath, encodedPath, unexpectedPath, outsidePath);
    fixtureGit(
      repoRoot,
      "-c", "user.name=Harness Test",
      "-c", "user.email=harness@example.test",
      "-c", "commit.gpgSign=false",
      "commit", "--no-verify", "-m", "seed"
    );
    const head = fixtureGit(repoRoot, "rev-parse", "HEAD").trim();
    const vcs = makeLocalVersionControlSystem();

    assert.deepEqual(
      vcs.filesExistingAtCommit(repoRoot, head, {
        relativeRoot,
        relativePaths: [presentPath, encodedPath, missingPath]
      }),
      new Set([presentPath, encodedPath])
    );
    assert.deepEqual(
      vcs.filesExistingAtCommit(repoRoot, head, {
        relativeRoot: "",
        relativePaths: [presentPath, outsidePath, missingPath]
      }),
      new Set([presentPath, outsidePath])
    );
    assert.throws(
      () => vcs.filesExistingAtCommit(repoRoot, head, {
        relativeRoot,
        relativePaths: [outsidePath]
      }),
      /GIT_FILE_MEMBERSHIP_PATH_OUTSIDE_ROOT/u
    );
    assert.throws(
      () => vcs.filesExistingAtCommit(repoRoot, head, {
        relativeRoot: ".",
        relativePaths: [presentPath]
      }),
      /GIT_FILE_MEMBERSHIP_RELATIVEROOT_INVALID/u
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("bulk path membership fails closed when the commit tree cannot be read", () => {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "ha-bulk-git-membership-error-"));
  try {
    fixtureGit(repoRoot, "init", "-b", "bulk-membership-error-test");
    const vcs = makeLocalVersionControlSystem();

    assert.throws(
      () => vcs.filesExistingAtCommit(repoRoot, "missing-commit", {
        relativeRoot: "authority-attribution-events/v2",
        relativePaths: ["authority-attribution-events/v2/missing.jsonl"]
      }),
      (error: unknown) => error instanceof VcsCommandError
        && error.command === "ls-tree"
        && error.cwd === repoRoot
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

function fixtureGit(repoRoot: string, ...args: ReadonlyArray<string>): string {
  const fixtureControlDir = path.join(repoRoot, ".git-fixture-empty");
  mkdirSync(fixtureControlDir, { recursive: true });
  return execFileSync("git", [
    "-C", repoRoot,
    "-c", `core.hooksPath=${fixtureControlDir}`,
    ...args
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TEMPLATE_DIR: fixtureControlDir,
      GIT_TERMINAL_PROMPT: "0"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
}

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
