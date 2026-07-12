// harness-test-tier: integration
import { testWriteAttribution } from "../test-attribution.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { taskEntityId } from "../../src/domain/index.ts";
import { makeJournaledWriteCoordinator } from "../../src/store/index.ts";
import { makeLocalVersionControlSystem } from "../../src/store/local-version-control-system.ts";
import { withTempStore } from "./helpers.ts";

test("WriteCoordinator code-doc preflight accepts a commit from the private authored repository", () => {
  withTempStore((rootDir) => {
    const fixture = initializeNestedGitFixture(rootDir);
    const local = makeLocalVersionControlSystem();
    assert.equal(local.commitExists(rootDir, fixture.authoredSha), false, "the old outer-root lookup reproduces the missing commit");
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });

    const ack = Effect.runSync(coordinator.enqueue(codeDocOp(
      "private-code-doc",
      [{ kind: "commit", sha: fixture.authoredSha }]
    )));

    assert.equal(ack.accepted, true);
  });
});

test("WriteCoordinator code-doc preflight resolves mixed outer and authored repository anchors", () => {
  withTempStore((rootDir) => {
    const fixture = initializeNestedGitFixture(rootDir);
    const local = makeLocalVersionControlSystem();
    assert.equal(local.commitExists(rootDir, fixture.authoredSha), false);
    assert.equal(local.commitExists(fixture.authoredRoot, fixture.outerSha), false);
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });

    const ack = Effect.runSync(coordinator.enqueue(codeDocOp("mixed-code-doc", [
      { kind: "commit", sha: fixture.outerSha },
      { kind: "path", sha: fixture.authoredSha, path: fixture.authoredEvidencePath }
    ])));

    assert.equal(ack.accepted, true);
  });
});

function codeDocOp(opId: string, anchors: ReadonlyArray<Record<string, string>>) {
  return {
    opId,
    entityId: taskEntityId("task-1"),
    kind: "code_doc_reconcile" as const,
    payload: {
      path: "code-doc-anchors.json",
      body: `${JSON.stringify({
        schema: "code-doc-reconciliation/v1",
        taskId: "task-1",
        records: [{ id: "closeout", ledgerPath: "closeout.md", kind: "closeout", anchors }]
      }, null, 2)}\n`
    }
  };
}

function initializeNestedGitFixture(rootDir: string): {
  readonly authoredRoot: string;
  readonly outerSha: string;
  readonly authoredSha: string;
  readonly authoredEvidencePath: string;
} {
  const authoredRoot = path.join(rootDir, "harness");
  const authoredEvidencePath = "tasks/task-1/artifacts/impl-report.md";
  initializeGitRepository(rootDir);
  writeFileSync(path.join(rootDir, ".gitignore"), "harness/\n", "utf8");
  writeFileSync(path.join(rootDir, "public-delivery.txt"), "public delivery\n", "utf8");
  runHermeticGit(rootDir, "add", ".gitignore", "public-delivery.txt");
  runHermeticGit(rootDir, "commit", "-m", "seed public delivery");
  const outerSha = runHermeticGit(rootDir, "rev-parse", "HEAD");

  mkdirSync(path.dirname(path.join(authoredRoot, authoredEvidencePath)), { recursive: true });
  initializeGitRepository(authoredRoot);
  writeFileSync(path.join(authoredRoot, "tasks/task-1/closeout.md"), "# Closeout\n", "utf8");
  writeFileSync(path.join(authoredRoot, authoredEvidencePath), "private harness delivery\n", "utf8");
  runHermeticGit(authoredRoot, "add", "tasks/task-1/closeout.md", authoredEvidencePath);
  runHermeticGit(authoredRoot, "commit", "-m", "seed private delivery");
  const authoredSha = runHermeticGit(authoredRoot, "rev-parse", "HEAD");
  return { authoredRoot, outerSha, authoredSha, authoredEvidencePath };
}

function initializeGitRepository(repoRoot: string): void {
  mkdirSync(repoRoot, { recursive: true });
  runHermeticGit(repoRoot, "init");
}

function runHermeticGit(repoRoot: string, ...args: ReadonlyArray<string>): string {
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
