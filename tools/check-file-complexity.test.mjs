// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  countLines,
  evaluateFileComplexity,
  FILE_COMPLEXITY_POLICY,
  resolveBaselineRef,
} from "./check-file-complexity.mjs";

function git(rootDir, args) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function lines(count) {
  return Array.from({ length: count }, (_, index) => `line ${index}`).join("\n");
}

function write(rootDir, filePath, count) {
  const absolute = path.join(rootDir, filePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, lines(count), "utf8");
}

function fixture() {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-file-complexity-"));
  git(rootDir, ["init", "-q"]);
  git(rootDir, ["config", "user.name", "Harness Test"]);
  git(rootDir, ["config", "user.email", "harness@example.test"]);
  write(rootDir, "packages/kernel/src/existing.ts", 10);
  git(rootDir, ["add", "."]);
  git(rootDir, ["commit", "-qm", "baseline"]);
  return rootDir;
}

test("the executable policy has one final and transition limit per file class", () => {
  assert.deepEqual(FILE_COMPLEXITY_POLICY, {
    source: { standard: 600, transition: 900 },
    test: { standard: 700, transition: 1400 },
    tool: { standard: 650, transition: 700 },
  });
});

test("a trailing newline does not create a phantom extra line", () => {
  assert.equal(countLines("one\n"), 1);
  assert.equal(countLines("one\ntwo\n"), 2);
});

for (const [filePath, standard] of [
  ["packages/kernel/src/new.ts", 600],
  ["packages/kernel/test/new.test.ts", 700],
  ["tools/new-tool.mjs", 650],
]) {
  test(`new ${filePath} files use the final standard immediately`, async () => {
    const rootDir = fixture();
    try {
      const base = git(rootDir, ["rev-parse", "HEAD"]);
      write(rootDir, filePath, standard + 1);
      const result = await evaluateFileComplexity({ rootDir, base });
      assert.equal(result.ok, false);
      assert.deepEqual(result.violations, [
        `${filePath}: ${standard + 1} lines exceeds max ${standard} (new file standard ${standard}); ` +
          "split this file by responsibility instead of shaving lines",
      ]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}

test("a legacy file above the transition tier may shrink but may not grow", async () => {
  const rootDir = fixture();
  try {
    const filePath = "packages/kernel/src/legacy.ts";
    write(rootDir, filePath, 950);
    git(rootDir, ["add", "."]);
    git(rootDir, ["commit", "-qm", "record legacy file"]);
    const base = git(rootDir, ["rev-parse", "HEAD"]);

    write(rootDir, filePath, 951);
    const growth = await evaluateFileComplexity({ rootDir, base });
    assert.equal(growth.ok, false);
    assert.match(growth.violations.join("\n"), /legacy\.ts: 951 lines exceeds max 950/u);

    write(rootDir, filePath, 949);
    const shrink = await evaluateFileComplexity({ rootDir, base });
    assert.equal(shrink.ok, true, shrink.violations.join("\n"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the baseline resolver compares a clean branch with its merge base", () => {
  const rootDir = fixture();
  try {
    const baseline = git(rootDir, ["rev-parse", "HEAD"]);
    git(rootDir, ["update-ref", "refs/remotes/origin/main", baseline]);
    write(rootDir, "packages/kernel/src/branch.ts", 10);
    git(rootDir, ["add", "."]);
    git(rootDir, ["commit", "-qm", "branch change"]);
    assert.equal(resolveBaselineRef(rootDir), baseline);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("the checker fails closed when its requested Git baseline is unavailable", async () => {
  const rootDir = fixture();
  try {
    await assert.rejects(
      evaluateFileComplexity({ rootDir, base: "missing-baseline" }),
      /Command failed: git rev-parse --verify missing-baseline\^\{commit\}/u,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
