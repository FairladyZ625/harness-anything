// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeLocalVersionControlSystem } from "../../kernel/src/index.ts";
import { CODE_DOC_RECONCILIATION_DOCUMENT, evaluateCodeDocReconciliationGate } from "../src/code-doc-reconciliation.ts";

test("code-doc reconciliation resolves a private harness commit outside the outer repository history", () => {
  withNestedGitFixture(({ rootDir, authoredRoot, outerSha, authoredSha }) => {
    const versionControlSystem = makeLocalVersionControlSystem();
    assert.equal(versionControlSystem.commitExists(rootDir, authoredSha), false, "the old outer-root lookup reproduces the missing commit");

    const result = evaluateCodeDocReconciliationGate({
      taskId: "task-1",
      rootDir,
      authoredRoot,
      versionControlSystem,
      documents: documents([{ kind: "commit", sha: authoredSha }])
    });

    assert.equal(result.ok, true);
    assert.notEqual(outerSha, authoredSha);
  });
});

test("code-doc reconciliation resolves public and private anchors independently in one document", () => {
  withNestedGitFixture(({ rootDir, authoredRoot, outerSha, authoredSha, authoredEvidencePath }) => {
    const versionControlSystem = makeLocalVersionControlSystem();
    assert.equal(versionControlSystem.commitExists(rootDir, authoredSha), false, "private commit is absent from the outer repository");
    assert.equal(versionControlSystem.commitExists(authoredRoot, outerSha), false, "public commit is absent from the authored repository");

    const result = evaluateCodeDocReconciliationGate({
      taskId: "task-1",
      rootDir,
      authoredRoot,
      versionControlSystem,
      documents: documents([
        { kind: "commit", sha: outerSha },
        { kind: "path", sha: authoredSha, path: authoredEvidencePath }
      ])
    });

    assert.equal(result.ok, true);
    assert.equal(result.checkedAnchors, 2);
  });
});

function documents(anchors: ReadonlyArray<Record<string, string>>) {
  return [
    { path: "closeout.md", body: "# Closeout\n" },
    {
      path: CODE_DOC_RECONCILIATION_DOCUMENT,
      body: `${JSON.stringify({
        schema: "code-doc-reconciliation/v1",
        taskId: "task-1",
        records: [{ id: "closeout", ledgerPath: "closeout.md", kind: "closeout", anchors }]
      }, null, 2)}\n`
    }
  ];
}

function withNestedGitFixture(fn: (fixture: {
  readonly rootDir: string;
  readonly authoredRoot: string;
  readonly outerSha: string;
  readonly authoredSha: string;
  readonly authoredEvidencePath: string;
}) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-code-doc-git-roots-"));
  const authoredRoot = path.join(rootDir, "harness");
  const authoredEvidencePath = "tasks/task-1/artifacts/impl-report.md";
  try {
    initializeRepo(rootDir);
    writeFileSync(path.join(rootDir, ".gitignore"), "harness/\n", "utf8");
    writeFileSync(path.join(rootDir, "public-delivery.txt"), "public delivery\n", "utf8");
    git(rootDir, "add", ".gitignore", "public-delivery.txt");
    git(rootDir, "commit", "-m", "seed public delivery");
    const outerSha = git(rootDir, "rev-parse", "HEAD");

    mkdirSync(path.dirname(path.join(authoredRoot, authoredEvidencePath)), { recursive: true });
    initializeRepo(authoredRoot);
    writeFileSync(path.join(authoredRoot, authoredEvidencePath), "private harness delivery\n", "utf8");
    git(authoredRoot, "add", authoredEvidencePath);
    git(authoredRoot, "commit", "-m", "seed private delivery");
    const authoredSha = git(authoredRoot, "rev-parse", "HEAD");

    fn({ rootDir, authoredRoot, outerSha, authoredSha, authoredEvidencePath });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function initializeRepo(repoRoot: string): void {
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, "init");
}

function git(repoRoot: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", [
    "-c", "user.name=Harness Test",
    "-c", "user.email=harness-test@example.invalid",
    "-c", "commit.gpgsign=false",
    ...args
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
