// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { deriveCloseoutSubmission } from "../src/repo-cell-submit.ts";
import { openDispatchStream } from "../src/dispatch-stream.ts";

const packagePath = "tasks/task-1";
const documentPath = `${packagePath}/closeout.md`;
const git = (root: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const put = (root: string, file: string, body: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), body);
};
const commit = (root: string) => {
  git(root, "add", "-A");
  git(root, "commit", "-qm", "test: delivery cut");
  return git(root, "rev-parse", "HEAD");
};
const closeout = (summary: string) =>
  `## Summary\n${summary}\n## Verification\nTests passed.\n` +
  "## Residual Risk\n已知缺口：publication pending.\n" +
  "## Same Mechanism Elsewhere\nSibling delivery remains unverified.\n";

function fixture(t: TestContext, sharedGit = false) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-closeout-cut-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const init = (directory: string) => {
    mkdirSync(directory, { recursive: true });
    git(directory, "init", "-q", "-b", "main");
    git(directory, "config", "user.name", "Harness Test");
    git(directory, "config", "user.email", "harness@example.test");
    git(directory, "config", "commit.gpgsign", "false");
  };
  init(root);
  put(root, ".gitignore", "harness/\n.harness/\n");
  put(root, "src/old.ts", "export const oldValue = 1;\n");
  put(root, "src/live.ts", "export const liveValue = 1;\n");
  const base = commit(root);
  git(root, "update-ref", "refs/remotes/origin/main", base);
  const ledger = path.join(root, "harness");
  if (sharedGit) mkdirSync(ledger, { recursive: true });
  else {
    init(ledger);
    put(ledger, "README.md", "Private ledger.\n");
    commit(ledger);
  }
  return { root, ledger, base };
}

function derive(rootDir: string, summary: string, missingPath?: string) {
  const snapshot = { executions: [], task: { completionGateIds: ["ci"] } } as unknown as Parameters<
      typeof deriveCloseoutSubmission
    >[3],
    body = closeout(summary),
    projection = {
      read: () => ({ watermark: 1, sourceRevision: 1, snapshot: { ...snapshot, task: {} }, packagePath }),
      readDocument: (target: string) => ({
        watermark: 1,
        sourceRevision: 1,
        document:
          target === missingPath
            ? null
            : {
                body: target.endsWith("task-contract.json")
                  ? JSON.stringify({ documents: [{ slot: "task.closeout", path: "closeout.md" }] })
                  : body,
                blobSha256: "test-blob",
                workspaceRevision: 1,
              },
      }),
    } as unknown as Parameters<typeof deriveCloseoutSubmission>[0]["projection"];
  return deriveCloseoutSubmission(
    {
      rootDir,
      projection,
      cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    },
    "task-1",
    "execution-1",
    snapshot,
  );
}

function dispatch(root: string, cwd: string) {
  openDispatchStream(root, {
    dispatchId: "dispatch_111111111111111111111111",
    taskId: "task-1",
    executionId: "execution-1",
    runtimeSessionId: "runtime_111111111111111111111111",
    instanceId: "instance-1",
    startedAt: "2026-09-12T00:00:00.000Z",
    cwd,
  });
}

test("explicit Summary commit derives mixed deletion evidence without a dispatch", (t) => {
  const { root } = fixture(t);
  rmSync(path.join(root, "src/old.ts"));
  put(root, "src/live.ts", "export const liveValue = 2;\n");
  const sha = commit(root),
    packet = derive(root, `Delivered ${sha}.`);
  assert.equal(packet.commitSha, sha);
  assert.deepEqual(packet.deliverables, ["src/live.ts"]);
  assert.deepEqual(packet.outputs, ["Deleted-Production-Paths: src/old.ts"]);
  assert.deepEqual(packet.knownGaps, ["已知缺口：publication pending.", "Sibling delivery remains unverified."]);
});

test("pure deletion cut has no surviving anchor paths and keeps the deletion list", (t) => {
  const { root } = fixture(t);
  rmSync(path.join(root, "src/old.ts"));
  const sha = commit(root),
    packet = derive(root, `Delivered ${sha}.`);
  assert.deepEqual(packet.deliverables, []);
  assert.deepEqual(packet.outputs, ["Deleted-Production-Paths: src/old.ts"]);
});

test("rename cut anchors the surviving target path", (t) => {
  const { root } = fixture(t);
  git(root, "config", "diff.renames", "true");
  renameSync(path.join(root, "src/old.ts"), path.join(root, "src/renamed.ts"));
  const sha = commit(root),
    packet = derive(root, `Delivered ${sha}.`);
  assert.deepEqual(packet.deliverables, ["src/renamed.ts"]);
  assert.deepEqual(packet.outputs, []);
});

test("bound dispatch supplies HEAD without an explicit Summary SHA", (t) => {
  const { root } = fixture(t);
  put(root, "src/live.ts", "export const liveValue = 3;\n");
  const sha = commit(root);
  dispatch(root, root);
  assert.equal(derive(root, "Completed the live path.").commitSha, sha);
});

test("missing dispatch requires an explicit Summary cut and rejects ambiguous commits", (t) => {
  const { root, base } = fixture(t);
  put(root, "src/live.ts", "export const liveValue = 3;\n");
  const sha = commit(root);
  assert.throws(() => derive(root, "Completed the live path."), { code: "invalid_submission" });
  assert.throws(() => derive(root, `Delivered ${base} and ${sha}.`), { code: "invalid_submission" });
  assert.throws(() => derive(root, `Delivered ${"f".repeat(40)}.`), { code: "invalid_submission" });
});

test("private ledger cut selects only this task's committed artifacts", (t) => {
  const { root, ledger } = fixture(t);
  put(ledger, `${packagePath}/artifacts/report.md`, "Evidence.\n");
  put(ledger, "tasks/task-2/artifacts/report.md", "Other evidence.\n");
  const sha = commit(ledger),
    packet = derive(root, `Delivered ${sha}.`);
  assert.equal(packet.commitSha, sha);
  assert.deepEqual(packet.deliverables, [`${packagePath}/artifacts/report.md`]);
  assert.deepEqual(packet.outputs, []);
});

test("missing ledger artifact paths and missing projected documents fail closed", (t) => {
  const { root, ledger } = fixture(t);
  put(ledger, "tasks/task-2/artifacts/report.md", "Other evidence.\n");
  const sha = commit(ledger);
  assert.throws(() => derive(root, `Delivered ${sha}.`), { code: "invalid_submission" });
  for (const missing of [documentPath, `${packagePath}/task-contract.json`])
    assert.throws(() => derive(root, `Delivered ${sha}.`, missing), { code: "content_not_ready" });
  dispatch(root, path.join(root, "missing-worktree"));
  assert.throws(() => derive(root, "Completed the live path."), { code: "invalid_submission" });
});

test("ledger artifact cut respects an authored subdirectory prefix", (t) => {
  const { root, ledger } = fixture(t);
  put(ledger, "harness.yaml", "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness/authored\n");
  put(ledger, `authored/${packagePath}/artifacts/report.md`, "Evidence.\n");
  const sha = commit(ledger),
    packet = derive(root, `Delivered ${sha}.`);
  assert.deepEqual(packet.deliverables, [`authored/${packagePath}/artifacts/report.md`]);
});

test("shared public and authored Git root keeps a code delivery on its public cut", (t) => {
  const { root } = fixture(t, true);
  put(root, "src/live.ts", "export const liveValue = 4;\n");
  const sha = commit(root),
    packet = derive(root, `Delivered ${sha}.`);
  assert.equal(packet.commitSha, sha);
  assert.deepEqual(packet.deliverables, ["src/live.ts"]);
});

test("already merged dispatch preserves earlier branch changes and rejects unrelated Summary cut", (t) => {
  const { root, base } = fixture(t);
  git(root, "checkout", "-qb", "worker");
  put(root, "src/first.ts", "first\n");
  commit(root);
  put(root, "src/second.ts", "second\n");
  const head = commit(root);
  git(root, "checkout", "-q", "main");
  git(root, "merge", "--no-ff", "-qm", "test: merge delivery", "worker");
  const merged = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", merged);
  git(root, "checkout", "-q", "worker");
  dispatch(root, root);
  assert.deepEqual(derive(root, "Worktree delivery.").deliverables, ["src/first.ts", "src/second.ts"]);
  assert.equal(derive(root, `Delivery ${merged}`).commitSha, merged);
  assert.throws(() => derive(root, `Delivery ${base}`), /bound worktree HEAD/u);
  assert.equal(derive(root, "Worktree delivery.").commitSha, head);
});

test("removed dispatch worktree resolves an explicit published cut in the canonical repository", (t) => {
  const { root } = fixture(t),
    cwd = path.join(root, "worker");
  git(root, "worktree", "add", "-qb", "worker", cwd);
  put(cwd, "src/delivery.ts", "delivery\n");
  commit(cwd);
  dispatch(root, cwd);
  git(root, "merge", "--no-ff", "-qm", "test: merge delivery", "worker");
  const merged = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", merged);
  git(root, "worktree", "remove", cwd);
  assert.equal(derive(root, `Delivery ${merged}`).commitSha, merged);
  assert.deepEqual(derive(root, `Delivery ${merged}`).deliverables, ["src/delivery.ts"]);
  assert.throws(() => derive(root, "Delivery complete."), /no execution-bound worktree cut/u);
  assert.throws(() => derive(root, `Delivery ${"f".repeat(40)}`), /not published/u);
  put(root, "src/unpublished.ts", "unpublished\n");
  const unpublished = commit(root);
  assert.throws(() => derive(root, `Delivery ${unpublished}`), /published merge commit/u);
});
