// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { sha256Bytes } from "../../kernel/src/index.ts";
import { deriveCloseoutSubmission, submissionAnchorDriftWarnings, submissionStopped } from "../src/repo-cell-submit.ts";
import { openDispatchStream } from "../src/dispatch-stream.ts";
import type { RepoCellBinding, RepoTaskAction, Snapshot } from "../src/repo-cell-types.ts";

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

function artifactStore() {
  const artifactPath = `${packagePath}/artifacts/report.md`,
    bytes = Buffer.from("Frozen report.\n"),
    blobSha256 = sha256Bytes(bytes);
  return {
    blobSha256,
    store: {
      readBatch: (cursor: string) => ({
        events:
          Number(cursor) === 6
            ? [
                {
                  schema: "doc-event/v1",
                  workspaceRevision: 7,
                  opId: "accepted-7",
                  payload: { changes: [{ path: artifactPath, candidate: { sha256: blobSha256 } }] },
                },
              ]
            : [],
      }),
      readContentBlob: () => bytes,
    },
  };
}

/** The execution's start-frozen baseline: the repository root commit by default. */
function baseline(root: string) {
  return { kind: "commit" as const, commitSha: git(root, "rev-list", "--max-parents=0", "HEAD") };
}

function derive(
  rootDir: string,
  summary: string,
  missingPath?: string,
  gates: readonly string[] = ["ci"],
  store: Parameters<typeof deriveCloseoutSubmission>[0]["store"] = {} as Parameters<
    typeof deriveCloseoutSubmission
  >[0]["store"],
  deliveryBaseline:
    | { readonly kind: "commit"; readonly commitSha: string }
    | { readonly kind: "empty-tree" }
    | null
    | undefined = rootDir === "/nonexistent" ? { kind: "empty-tree" } : baseline(rootDir),
) {
  const snapshot = {
      executions: [
        {
          schema: "execution/v1",
          executionId: "execution-1",
          taskId: "task-1",
          nodeId: "implementation",
          iteration: 0,
          state: "active",
          actor: { principal: { personId: "owner" }, executor: null },
          claimedAt: "2026-09-12T00:00:00.000Z",
          submittedAt: null,
          closedAt: null,
          submission: null,
          ...(deliveryBaseline == null ? {} : { deliveryBaseline }),
        },
      ],
      task: { completionGateIds: gates },
    } as unknown as Parameters<typeof deriveCloseoutSubmission>[3],
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
      store,
      cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
      settings: {
        readRepository: () => ({
          ci: { workflows: ["rewrite-ci"] },
          gates: [
            {
              gateId: "ci",
              adapter: "github-actions",
              appliesTo: "code",
              branch: "main",
              event: "push",
              coverage: "exact",
              selection: "newest",
            },
          ],
        }),
      } as unknown as Parameters<typeof deriveCloseoutSubmission>[0]["settings"],
    },
    "task-1",
    "execution-1",
    snapshot,
  );
}

function dispatch(root: string, cwd: string, dispatchId = "dispatch_111111111111111111111111") {
  openDispatchStream(root, {
    dispatchId,
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

test("Summary commit plus artifact anchor derives one cut carrying both", (t) => {
  const { root } = fixture(t),
    { store, blobSha256 } = artifactStore(),
    anchor = `artifact:${packagePath}/artifacts/report.md@7`;
  put(root, "src/live.ts", "export const liveValue = 6;\n");
  const sha = commit(root),
    packet = derive(
      root,
      `Delivered ${sha} with ${anchor} attached.`,
      undefined,
      ["ci", "code-doc-reconciliation"],
      store,
    );
  assert.equal(packet.commitSha, sha);
  assert.deepEqual(packet.artifacts, [{ path: `${packagePath}/artifacts/report.md`, revision: 7, blobSha256 }]);
  // Deliverables stay paths of the delivery commit; the anchored report rides in outputs.
  assert.deepEqual(packet.deliverables, ["src/live.ts"]);
  assert.deepEqual(packet.outputs, [`Artifact-Anchor: ${packagePath}/artifacts/report.md@7`]);
});

test("artifact anchors alone still deliver without a commit and reject duplicate paths", () => {
  const { store, blobSha256 } = artifactStore();
  const guided = derive("/nonexistent", "artifact:artifacts/report.md@7", undefined, ["ci"], store);
  assert.deepEqual(guided.artifacts, [{ path: `${packagePath}/artifacts/report.md`, revision: 7, blobSha256 }]);
  assert.deepEqual(guided.deliverables, [`${packagePath}/artifacts/report.md`]);
  const packet = derive("/nonexistent", `artifact:${packagePath}/artifacts/report.md@7`, undefined, ["ci"], store);
  assert.equal(packet.commitSha, null);
  assert.deepEqual(packet.deliverables, [`${packagePath}/artifacts/report.md`]);
  assert.throws(
    () =>
      derive(
        "/nonexistent",
        `artifact:${packagePath}/artifacts/report.md@7 artifact:${packagePath}/artifacts/report.md@7`,
        undefined,
        ["ci"],
        store,
      ),
    /name each artifact path once/u,
  );
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

test("bound dispatch cannot substitute HEAD for an explicit Summary anchor", (t) => {
  const { root } = fixture(t);
  put(root, "src/live.ts", "export const liveValue = 3;\n");
  const sha = commit(root);
  dispatch(root, root);
  assert.throws(() => derive(root, "Completed the live path."), { code: "invalid_submission" });
  assert.equal(derive(root, `Delivered ${sha}`).commitSha, sha);
});

test("missing dispatch requires an explicit Summary cut and rejects ambiguous commits", (t) => {
  const { root, base } = fixture(t);
  put(root, "src/live.ts", "export const liveValue = 3;\n");
  const sha = commit(root);
  assert.throws(() => derive(root, "Completed the live path."), { code: "invalid_submission" });
  assert.throws(() => derive(root, `Delivered ${base} and ${sha}.`), /names 2 delivery commits/u);
  assert.throws(() => derive(root, `Delivered ${"f".repeat(40)}.`), { code: "invalid_submission" });
});

test("a private Git commit cannot substitute for an artifact acceptance revision", (t) => {
  const { root, ledger } = fixture(t);
  put(ledger, `${packagePath}/artifacts/report.md`, "Evidence.\n");
  const sha = commit(ledger);
  assert.throws(() => derive(root, `Delivered ${sha}.`), { code: "invalid_submission" });
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
  commit(root);
  git(root, "checkout", "-q", "main");
  git(root, "merge", "--no-ff", "-qm", "test: merge delivery", "worker");
  const merged = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", merged);
  git(root, "checkout", "-q", "worker");
  dispatch(root, root);
  assert.deepEqual(derive(root, `Delivery ${merged}`).deliverables, ["src/first.ts", "src/second.ts"]);
  assert.equal(derive(root, `Delivery ${merged}`).commitSha, merged);
  // Naming an older published commit is still rejected, by the comparison-cut check rather than
  // by any relationship to the dispatch HEAD.
  assert.throws(() => derive(root, `Delivery ${base}`), /no changed paths/u);
  assert.throws(() => derive(root, "Worktree delivery."), { code: "invalid_submission" });
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
  assert.throws(() => derive(root, "Delivery complete."), /one delivery commit or at least one artifact/u);
  assert.throws(() => derive(root, `Delivery ${"f".repeat(40)}`), /not published/u);
  put(root, "src/unpublished.ts", "unpublished\n");
  const unpublished = commit(root);
  assert.throws(() => derive(root, `Delivery ${unpublished}`), /published merge commit/u);
});

test("one execution with two dispatch directories accepts its published merge cut", (t) => {
  const { root } = fixture(t),
    worker = path.join(root, "worker");
  git(root, "worktree", "add", "-qb", "worker", worker);
  put(worker, "src/delivery.ts", "delivery\n");
  commit(worker);
  git(root, "merge", "--no-ff", "-qm", "test: merge delivery", "worker");
  const merged = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", merged);
  dispatch(root, worker);
  dispatch(root, root, "dispatch_222222222222222222222222");
  const packet = derive(root, `Delivery ${merged}.`);
  assert.equal(packet.commitSha, merged);
  assert.deepEqual(packet.deliverables, ["src/delivery.ts"]);
});

test("a published cut is accepted even when no dispatch HEAD explains it", (t) => {
  const { root } = fixture(t),
    worker = path.join(root, "worker");
  git(root, "worktree", "add", "-qb", "worker", worker);
  put(worker, "src/delivery.ts", "delivery\n");
  commit(worker);
  git(root, "merge", "--no-ff", "-qm", "test: merge delivery", "worker");
  const merged = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", merged);
  // The worker moved on to an unrelated commit after the merge: its HEAD is neither the named
  // cut nor an ancestor of it.
  put(worker, "src/unrelated.ts", "unrelated\n");
  commit(worker);
  dispatch(root, worker);
  const packet = derive(root, `Delivery ${merged}.`);
  assert.equal(packet.commitSha, merged);
  assert.deepEqual(packet.deliverables, ["src/delivery.ts"]);
});

test("dispatch-bound documentation task with an empty product cut falls back to ledger artifacts", (t) => {
  const { root, ledger } = fixture(t);
  put(ledger, `${packagePath}/artifacts/report.md`, "Evidence.\n");
  commit(ledger);
  git(root, "commit", "-q", "--allow-empty", "-m", "test: empty product cut");
  const empty = git(root, "rev-parse", "HEAD");
  dispatch(root, root);
  const packet = derive(root, `Delivered ${empty}.`, undefined, []);
  assert.equal(packet.commitSha, git(ledger, "rev-parse", "HEAD"));
  assert.deepEqual(packet.deliverables, [`${packagePath}/artifacts/report.md`]);
  assert.deepEqual(packet.outputs, []);
});

test("ledger fallback still fails closed when the task has no accepted artifacts", (t) => {
  const { root } = fixture(t);
  git(root, "commit", "-q", "--allow-empty", "-m", "test: empty product cut");
  const empty = git(root, "rev-parse", "HEAD");
  dispatch(root, root);
  assert.throws(() => derive(root, `Delivered ${empty}.`, undefined, []), {
    code: "invalid_submission",
    message: /artifacts/u,
  });
});

test("a stopped submission keeps the invalid_submission message as its rejection explanation", () => {
  const cell = {
      input: { repoId: "canonical" },
      operationId: () => "op_stopped",
      rejected: (opId: string, code: string) => ({
        outcome: "op_rejected",
        opId,
        code,
        origin: "daemon",
        evidence: `rejection:${code}`,
        diagnostic: { kind: "failure", code },
      }),
    } as unknown as Parameters<typeof submissionStopped>[0],
    error = Object.assign(new Error("Delivery cut contains no changed paths."), { code: "invalid_submission" }),
    receipt = submissionStopped(
      cell,
      { kind: "task-submit", taskId: "task-1" } as RepoTaskAction,
      {} as RepoCellBinding,
      { revision: 3 } as Snapshot,
      "execution-1",
      packagePath,
      error,
    );
  assert.equal(receipt.code, "document_invalid");
  assert.equal(receipt.rejectionExplanation, "Delivery cut contains no changed paths.");
  assert.match(receipt.next?.[0]?.action ?? "", /ha doc sync --submit --task task-1/u);
});

test("anchor drift warning fires only when the delivery cut moved under unchanged closeout prose", () => {
  const anchor = {
      path: `${packagePath}/artifacts/report.md`,
      revision: 7,
      blobSha256: "a".repeat(64),
    },
    submitted = {
      completionClaim: "Delivered the report.",
      deliverables: ["src/live.ts"],
      outputs: [`Artifact-Anchor: ${anchor.path}@${anchor.revision}`],
      verificationNotes: ["Tests passed."],
      knownGaps: [],
      residualRisks: [],
      commitSha: "a".repeat(40),
      artifacts: [anchor],
    };
  // The artifact anchor (or any other delivery-cut field) moved while closeout prose did not.
  for (const drifted of [
    { ...submitted, artifacts: [{ ...anchor, revision: 8 }] },
    { ...submitted, deliverables: ["src/live.ts", "src/extra.ts"] },
    { ...submitted, commitSha: "b".repeat(40) },
  ])
    assert.deepEqual(submissionAnchorDriftWarnings(submitted, drifted), [
      "Anchored artifact deliveries changed while the closeout prose did not; " +
        "verify the closeout claim still describes the delivered artifacts.",
    ]);
  // No previous submission, an identical cut, or revised prose: no advisory.
  assert.deepEqual(submissionAnchorDriftWarnings(null, submitted), []);
  assert.deepEqual(submissionAnchorDriftWarnings(submitted, submitted), []);
  assert.deepEqual(submissionAnchorDriftWarnings(submitted, { ...submitted, completionClaim: "Revised claim." }), []);
});

// -- frozen delivery baseline (dec_59FA45A407F850E2B167A192D7: execution start owns the cut) ------

test("a root-commit delivery on an unborn repository diffs against the empty tree", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-closeout-unborn-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Harness Test");
  git(root, "config", "user.email", "harness@example.test");
  put(root, "src/first.ts", "export const first = 1;\n");
  const sha = commit(root);
  dispatch(root, root);
  const packet = derive(root, `Delivered ${sha}.`, undefined, ["ci"], undefined, { kind: "empty-tree" });
  assert.equal(packet.commitSha, sha);
  assert.deepEqual(packet.deliverables, ["src/first.ts"]);
});

test("a multi-commit delivery lists every path changed since the frozen baseline", (t) => {
  const { root } = fixture(t);
  put(root, "src/first.ts", "first\n");
  commit(root);
  put(root, "src/second.ts", "second\n");
  const sha = commit(root);
  dispatch(root, root);
  const packet = derive(root, `Delivered ${sha}.`);
  assert.equal(packet.commitSha, sha);
  assert.deepEqual(packet.deliverables, ["src/first.ts", "src/second.ts"]);
});

test("an execution without a frozen baseline fails closed instead of guessing one", (t) => {
  const { root } = fixture(t);
  put(root, "src/live.ts", "export const liveValue = 9;\n");
  const sha = commit(root);
  dispatch(root, root);
  assert.throws(() => derive(root, `Delivered ${sha}.`, undefined, ["ci"], undefined, null), {
    code: "invalid_submission",
    message: /no frozen delivery baseline/u,
  });
});

test("a frozen baseline unreadable in the delivery repository fails closed", (t) => {
  const { root } = fixture(t);
  put(root, "src/live.ts", "export const liveValue = 10;\n");
  const sha = commit(root);
  dispatch(root, root);
  assert.throws(
    () =>
      derive(root, `Delivered ${sha}.`, undefined, ["ci"], undefined, {
        kind: "commit",
        commitSha: "f".repeat(40),
      }),
    { code: "invalid_submission", message: /not readable/u },
  );
});

test("the frozen baseline does not move when the project HEAD advances after start", (t) => {
  const { root, base } = fixture(t);
  put(root, "src/delivery.ts", "delivery\n");
  const sha = commit(root);
  dispatch(root, root);
  // The baseline was frozen at fixture time (base); the delivery cut itself is the new HEAD.
  const packet = derive(root, `Delivered ${sha}.`, undefined, ["ci"], undefined, {
    kind: "commit",
    commitSha: base,
  });
  assert.deepEqual(packet.deliverables, ["src/delivery.ts"]);
});
