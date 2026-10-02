// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { sha256Bytes } from "@harness-anything/kernel";
import { deriveCloseoutSubmission, submissionAnchorDriftWarnings } from "../src/repo-cell-submit.ts";
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

function artifactStore() {
  const artifactPath = `${packagePath}/artifacts/report.md`,
    bytes = Buffer.from("Frozen report.\n"),
    blobSha256 = sha256Bytes(bytes);
  return {
    blobSha256,
    store: {
      readEventAtRevision: (revision: number) =>
        revision === 7
          ? {
              schema: "doc-event/v1",
              workspaceRevision: 7,
              opId: "accepted-7",
              payload: { changes: [{ path: artifactPath, candidate: { sha256: blobSha256 } }] },
            }
          : null,
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
  commitSha?: string,
  // The delivery falls to this output shape, never the completion gate set: a repository-diff task always
  // carries a public delivery commit, even with an empty (lightweight) gate list.
  outputShape: "repository-diff" | "task-package-artifact" = "repository-diff",
  priorCommit?: string,
  frozenSubmission?: ReturnType<typeof deriveCloseoutSubmission>,
) {
  const snapshot = {
      executions: [
        ...(priorCommit ? [{ executionId: "earlier-execution", submission: { commitSha: priorCommit } }] : []),
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
          submission: frozenSubmission ?? null,
          ...(deliveryBaseline == null ? {} : { deliveryBaseline }),
        },
      ],
      task: {
        taskId: "task-1",
        taskClass: "standard",
        presetSnapshotDigest: "snapshot-task-1",
        completionGateIds: gates,
      },
    } as unknown as Parameters<typeof deriveCloseoutSubmission>[3],
    body = closeout(summary),
    projection = {
      readPresetSnapshot: () => ({ snapshot: { profile: { outputShape } } }),
      readRuntimeDispatchesByTaskExecution: () => [],
      read: () => ({ watermark: 1, sourceRevision: 1, snapshot: { ...snapshot, task: {} }, packagePath }),
      readDocument: (target: string) => ({
        watermark: 1,
        sourceRevision: 1,
        document:
          target === missingPath
            ? null
            : {
                body: target.endsWith("task-contract.json")
                  ? JSON.stringify({
                      documents: [
                        {
                          slot: "task.closeout",
                          path: "closeout.md",
                          templateRef: "template://planning/closeout@1",
                          locale: "en-US",
                        },
                      ],
                    })
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
    undefined,
    commitSha,
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

test("explicit structured commit derives mixed deletion evidence without a dispatch", (t) => {
  const { root } = fixture(t);
  rmSync(path.join(root, "src/old.ts"));
  put(root, "src/live.ts", "export const liveValue = 2;\n");
  const sha = commit(root),
    packet = derive(root, "Delivered the implementation.", undefined, ["ci"], undefined, undefined, sha);
  assert.equal(packet.commitSha, sha);
  assert.deepEqual(packet.deliverables, ["src/live.ts"]);
  assert.deepEqual(packet.outputs, ["Deleted-Production-Paths: src/old.ts"]);
  assert.deepEqual(packet.knownGaps, ["已知缺口：publication pending.", "Sibling delivery remains unverified."]);
});

test("structured commit plus artifact anchor derives one cut carrying both", (t) => {
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
      undefined,
      sha,
    );
  assert.equal(packet.commitSha, sha);
  assert.deepEqual(packet.artifacts, [{ path: `${packagePath}/artifacts/report.md`, revision: 7, blobSha256 }]);
  // Deliverables stay paths of the delivery commit; the anchored report rides in outputs.
  assert.deepEqual(packet.deliverables, ["src/live.ts"]);
  assert.deepEqual(packet.outputs, [`Artifact-Anchor: ${packagePath}/artifacts/report.md@7`]);
});

test("artifact anchors alone still deliver without a commit and reject duplicate paths", () => {
  const { store, blobSha256 } = artifactStore();
  const guided = derive(
    "/nonexistent",
    "artifact:artifacts/report.md@7",
    undefined,
    [],
    store,
    undefined,
    undefined,
    "task-package-artifact",
  );
  assert.deepEqual(guided.artifacts, [{ path: `${packagePath}/artifacts/report.md`, revision: 7, blobSha256 }]);
  assert.deepEqual(guided.deliverables, [`${packagePath}/artifacts/report.md`]);
  const packet = derive(
    "/nonexistent",
    `artifact:${packagePath}/artifacts/report.md@7`,
    undefined,
    [],
    store,
    undefined,
    undefined,
    "task-package-artifact",
  );
  assert.equal(packet.commitSha, null);
  assert.deepEqual(packet.deliverables, [`${packagePath}/artifacts/report.md`]);
  assert.throws(
    () =>
      derive(
        "/nonexistent",
        `artifact:${packagePath}/artifacts/report.md@7 artifact:${packagePath}/artifacts/report.md@7`,
        undefined,
        [],
        store,
        undefined,
        undefined,
        "task-package-artifact",
      ),
    /name each artifact path once/u,
  );
});

test("pure deletion cut has no surviving anchor paths and keeps the deletion list", (t) => {
  const { root } = fixture(t);
  rmSync(path.join(root, "src/old.ts"));
  const sha = commit(root),
    packet = derive(root, "Delivered the deletion.", undefined, ["ci"], undefined, undefined, sha);
  assert.deepEqual(packet.deliverables, []);
  assert.deepEqual(packet.outputs, ["Deleted-Production-Paths: src/old.ts"]);
});

test("rename cut anchors the surviving target path", (t) => {
  const { root } = fixture(t);
  git(root, "config", "diff.renames", "true");
  renameSync(path.join(root, "src/old.ts"), path.join(root, "src/renamed.ts"));
  const sha = commit(root),
    packet = derive(root, "Delivered the rename.", undefined, ["ci"], undefined, undefined, sha);
  assert.deepEqual(packet.deliverables, ["src/renamed.ts"]);
  assert.deepEqual(packet.outputs, []);
});

test("task worktree HEAD is the delivery commit without a runtime dispatch", (t) => {
  const { root } = fixture(t),
    worktree = path.join(root, ".worktrees/task-1");
  git(root, "worktree", "add", "-qb", "task-1", worktree);
  put(worktree, "src/live.ts", "export const liveValue = 4;\n");
  const sha = commit(worktree),
    old = git(root, "rev-parse", "HEAD");
  assert.equal(
    derive(root, `Completed the bound task worktree; prior cut was ${old}.`, undefined, ["ci"]).commitSha,
    sha,
  );
});

test("a rebase may advance the bound delivery commit without rewriting closeout prose", (t) => {
  const { root } = fixture(t),
    worktree = path.join(root, ".worktrees/task-1"),
    closeout = "Completed the implementation; execution records the delivery cut.";
  git(root, "worktree", "add", "-qb", "task-1", worktree);
  put(worktree, "src/live.ts", "export const liveValue = 41;\n");
  const beforeRebase = commit(worktree);
  put(root, "src/main-only.ts", "main\n");
  commit(root);
  git(worktree, "rebase", "main");
  const afterRebase = git(worktree, "rev-parse", "HEAD");
  assert.notEqual(afterRebase, beforeRebase);
  const submission = derive(root, closeout, undefined, ["ci"]);
  assert.equal(submission.commitSha, afterRebase);
  assert.equal(submission.completionClaim, closeout);
});

test("lightweight task worktree HEAD is the delivery commit though its gate set is empty", (t) => {
  const { root } = fixture(t),
    worktree = path.join(root, ".worktrees/task-1");
  git(root, "worktree", "add", "-qb", "task-1", worktree);
  put(worktree, "src/live.ts", "export const liveValue = 5;\n");
  const sha = commit(worktree),
    old = git(root, "rev-parse", "HEAD");
  // RED under the old completion-gate-based test: an empty gate set (the lightweight profile) used to
  // route this repository-diff task to the ledger outbox commit instead of the bound worktree HEAD.
  assert.equal(derive(root, `Completed the lightweight worktree; prior cut was ${old}.`, undefined, []).commitSha, sha);
});

test("missing dispatch requires an explicit structured delivery commit", (t) => {
  const { root, base } = fixture(t);
  put(root, "src/live.ts", "export const liveValue = 3;\n");
  const sha = commit(root);
  assert.throws(() => derive(root, "Completed the live path."), { code: "invalid_submission" });
  assert.equal(
    derive(root, `Earlier cuts: ${base} and ${"f".repeat(40)}.`, undefined, ["ci"], undefined, undefined, sha)
      .commitSha,
    sha,
  );
});

test("an old dispatch cwd in another checkout never stands in for the bound worktree HEAD", (t) => {
  const { root } = fixture(t),
    canonical = path.join(root, "canonical");
  // An earlier dispatch ran with --cwd pointed at another checkout; its HEAD is not this task's delivery.
  git(root, "worktree", "add", "-qb", "canonical", canonical);
  put(canonical, "src/foreign.ts", "foreign\n");
  commit(canonical);
  dispatch(root, canonical);
  assert.throws(() => derive(root, "Completed the live path."), {
    code: "invalid_submission",
    message: /No readable bound worktree HEAD exists; rerun with --commit/u,
  });
  put(root, "src/live.ts", "export const liveValue = 5;\n");
  const sha = commit(root);
  assert.equal(derive(root, "Completed.", undefined, ["ci"], undefined, undefined, sha).commitSha, sha);
});

test("a plain directory at the bound worktree path never lends the canonical HEAD", (t) => {
  const { root } = fixture(t);
  // A leftover ordinary directory at .worktrees/task-1: rev-parse there walks up to the canonical checkout.
  put(root, ".worktrees/task-1/leftover.txt", "not a worktree\n");
  assert.throws(() => derive(root, "Completed the live path.", undefined, ["ci"]), {
    code: "invalid_submission",
    message: /No readable bound worktree HEAD exists; rerun with --commit/u,
  });
});

test("explicit delivery commit must match a bound worktree HEAD and reports both values", (t) => {
  const { root, base } = fixture(t),
    worktree = path.join(root, ".worktrees/task-1");
  git(root, "worktree", "add", "-qb", "task-1", worktree);
  put(worktree, "src/live.ts", "export const liveValue = 3;\n");
  const head = commit(worktree);
  assert.throws(() => derive(root, "Complete.", undefined, ["ci"], undefined, undefined, base), {
    code: "invalid_submission",
    message: new RegExp(`${base}.*${head}`, "u"),
  });
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
    packet = derive(root, "Delivered the implementation.", undefined, ["ci"], undefined, undefined, sha);
  assert.equal(packet.commitSha, sha);
  assert.deepEqual(packet.deliverables, ["src/live.ts"]);
});

test("unpublished bound worktree HEAD preserves every branch commit before main", (t) => {
  const { root } = fixture(t);
  // The main checkout leaves the default branch below, so only origin/HEAD, as a clone records it, names main.
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const worktree = path.join(root, ".worktrees/task-1");
  git(root, "worktree", "add", "-qb", "task-1", worktree);
  put(worktree, "src/first.ts", "first\n");
  commit(worktree);
  put(worktree, "src/second.ts", "second\n");
  const head = commit(worktree),
    packet = derive(root, "Worktree delivery.", undefined, ["ci"]);
  assert.deepEqual(packet.deliverables, ["src/first.ts", "src/second.ts"]);
  assert.equal(packet.commitSha, head);
});

test("removed dispatch worktree resolves an explicit delivery cut in the canonical repository", (t) => {
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
  assert.equal(derive(root, "Delivery complete.", undefined, ["ci"], undefined, undefined, merged).commitSha, merged);
  assert.deepEqual(derive(root, "Delivery complete.", undefined, ["ci"], undefined, undefined, merged).deliverables, [
    "src/delivery.ts",
  ]);
  assert.throws(() => derive(root, "Delivery complete."), /No readable bound worktree HEAD/u);
  assert.throws(
    () => derive(root, "Delivery complete.", undefined, ["ci"], undefined, undefined, "f".repeat(40)),
    /not in any local clone/u,
  );
  put(root, "src/unpublished.ts", "unpublished\n");
  const unpublished = commit(root);
  assert.equal(
    derive(root, "Delivery complete.", undefined, ["ci"], undefined, undefined, unpublished).commitSha,
    unpublished,
  );
});

test("one execution with two dispatch directories and no bound worktree names no delivery from Summary prose", (t) => {
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
  assert.throws(() => derive(root, `Unrelated published merge ${merged}.`), /No readable bound worktree HEAD/u);
});

test("a structured commit differing from the bound HEAD is rejected", (t) => {
  const { root } = fixture(t),
    worker = path.join(root, ".worktrees/task-1");
  git(root, "worktree", "add", "-qb", "task-1", worker);
  put(worker, "src/delivery.ts", "delivery\n");
  commit(worker);
  git(root, "merge", "--no-ff", "-qm", "test: merge delivery", "task-1");
  const merged = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", merged);
  // The worker moved on to an unrelated commit after the merge: its HEAD is neither the named
  // cut nor an ancestor of it.
  put(worker, "src/unrelated.ts", "unrelated\n");
  commit(worker);
  assert.throws(
    () => derive(root, "Delivery complete.", undefined, ["ci"], undefined, undefined, merged),
    /does not match bound worktree HEAD/u,
  );
});

test("documentation task ignores unrelated Summary SHA and delivers ledger artifacts", (t) => {
  const { root, ledger } = fixture(t);
  put(ledger, `${packagePath}/artifacts/report.md`, "Evidence.\n");
  commit(ledger);
  const packet = derive(
    root,
    `Audited unrelated PR ${"f".repeat(40)}.`,
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    "task-package-artifact",
  );
  assert.equal(packet.commitSha, git(ledger, "rev-parse", "HEAD"));
  assert.deepEqual(packet.deliverables, [`${packagePath}/artifacts/report.md`]);
  assert.deepEqual(packet.outputs, []);
});

// Negative control (dec_BBA713052997C3EF5F5D3DD952): a task-package-artifact task keeps its ledger delivery
// even with a non-empty gate set, proving the shape-based determinant never keyed private delivery to gates.
test("a task-package-artifact task still delivers through the ledger with a non-empty gate set", (t) => {
  const { root, ledger } = fixture(t);
  put(ledger, `${packagePath}/artifacts/report.md`, "Evidence.\n");
  commit(ledger);
  const packet = derive(
    root,
    `Audited unrelated PR ${"f".repeat(40)}.`,
    undefined,
    ["ci", "code-doc-reconciliation"],
    undefined,
    undefined,
    undefined,
    "task-package-artifact",
  );
  assert.equal(packet.commitSha, git(ledger, "rev-parse", "HEAD"));
  assert.deepEqual(packet.deliverables, [`${packagePath}/artifacts/report.md`]);
});

test("ledger fallback still fails closed when the task has no accepted artifacts", (t) => {
  const { root } = fixture(t);
  git(root, "commit", "-q", "--allow-empty", "-m", "test: empty product cut");
  const empty = git(root, "rev-parse", "HEAD");
  dispatch(root, root);
  assert.throws(
    () => derive(root, `Delivered ${empty}.`, undefined, [], undefined, undefined, undefined, "task-package-artifact"),
    { code: "invalid_submission", message: /artifacts/u },
  );
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

// -- comparison-cut anchor (F-70FB11C4): the manifest belongs to the commit, not the clock ------

test("a root-commit delivery on an unborn repository diffs against the empty tree", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-closeout-unborn-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Harness Test");
  git(root, "config", "user.email", "harness@example.test");
  put(root, "src/first.ts", "export const first = 1;\n");
  const sha = commit(root);
  const packet = derive(root, `Delivered ${sha}.`, undefined, ["ci"], undefined, { kind: "empty-tree" }, sha);
  assert.equal(packet.commitSha, sha);
  assert.deepEqual(packet.deliverables, ["src/first.ts"]);
});

test("a multi-commit delivery lists every path changed since the frozen baseline", (t) => {
  const { root } = fixture(t);
  put(root, "src/first.ts", "first\n");
  commit(root);
  put(root, "src/second.ts", "second\n");
  const sha = commit(root);
  const packet = derive(root, `Delivered ${sha}.`, undefined, ["ci"], undefined, undefined, sha);
  assert.equal(packet.commitSha, sha);
  assert.deepEqual(packet.deliverables, ["src/first.ts", "src/second.ts"]);
});

test("an execution started before the baseline froze keeps the comparison cut in force when it started", (t) => {
  const { root } = fixture(t);
  put(root, "src/earlier.ts", "export const earlierValue = 8;\n");
  commit(root);
  put(root, "src/live.ts", "export const liveValue = 9;\n");
  const sha = commit(root);
  // The pre-freeze rule compares against the merge base with origin/main, so both commits are delivered.
  const packet = derive(root, `Delivered ${sha}.`, undefined, ["ci"], undefined, null, sha);
  assert.equal(packet.commitSha, sha);
  assert.deepEqual(packet.deliverables, ["src/earlier.ts", "src/live.ts"]);
});

test("a frozen baseline unreadable in an unanchored repository fails closed", (t) => {
  const { root } = fixture(t);
  // Only repositories without a default branch consult the frozen observation: no remote, and the main
  // checkout on a detached HEAD.
  git(root, "update-ref", "-d", "refs/remotes/origin/main");
  git(root, "checkout", "-q", "--detach");
  put(root, "src/live.ts", "export const liveValue = 10;\n");
  const sha = commit(root);
  assert.throws(
    () =>
      derive(
        root,
        `Delivered ${sha}.`,
        undefined,
        ["ci"],
        undefined,
        { kind: "commit", commitSha: "f".repeat(40) },
        sha,
      ),
    { code: "invalid_submission", message: /not readable/u },
  );
});

test("a repository without a remote anchors its cut on the local default branch, not the start observation", (t) => {
  const { root, base } = fixture(t);
  git(root, "update-ref", "-d", "refs/remotes/origin/main");
  // Ledger publications share the repository Git and land on main after the execution started.
  put(root, "ledger/INDEX.md", "published\n");
  commit(root);
  const worker = path.join(root, "worker");
  git(root, "worktree", "add", "-qb", "codex/delivery", worker);
  put(worker, "src/delivery.ts", "delivery\n");
  const delivery = commit(worker);
  put(root, "ledger/INDEX.md", "published again\n");
  commit(root);
  const started = { kind: "commit" as const, commitSha: base };
  assert.deepEqual(
    derive(root, "Delivered the worker cut.", undefined, ["ci"], undefined, started, delivery).deliverables,
    ["src/delivery.ts"],
  );
  // Delivered straight onto main after more ledger writes: the cut is that commit's own change.
  put(root, "ledger/INDEX.md", "published a third time\n");
  commit(root);
  put(root, "src/direct.ts", "direct\n");
  const direct = commit(root);
  git(root, "worktree", "remove", worker);
  assert.deepEqual(
    derive(root, "Delivered the direct cut.", undefined, ["ci"], undefined, started, direct).deliverables,
    ["src/direct.ts"],
  );
});

test("the comparison cut follows the delivery fork point, not the project HEAD at start", (t) => {
  const { root, base } = fixture(t);
  put(root, "src/delivery.ts", "delivery\n");
  const sha = commit(root);
  // The execution's start observation (base) predates the delivery; only the fork point counts.
  const packet = derive(
    root,
    `Delivered ${sha}.`,
    undefined,
    ["ci"],
    undefined,
    { kind: "commit", commitSha: base },
    sha,
  );
  assert.deepEqual(packet.deliverables, ["src/delivery.ts"]);
});

/** A moving-main world: sibling PRs land on main before and after this delivery merges. */
function movingMain(t: TestContext) {
  const { root, base } = fixture(t);
  // A sibling PR lands on main after this execution started (its start observation is `base`).
  put(root, "src/other-pr.ts", "other\n");
  commit(root);
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  // The delivery worktree forks from the advanced main and merges back with a merge commit.
  const worker = path.join(root, "worker");
  git(root, "worktree", "add", "-qb", "codex/delivery", worker);
  put(worker, "src/delivery.ts", "delivery\n");
  commit(worker);
  git(root, "merge", "--no-ff", "-qm", "test: merge delivery", "codex/delivery");
  const merged = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", merged);
  // A later PR advances main past the publication while the cut waits for review.
  put(root, "src/later-pr.ts", "later\n");
  const later = commit(root);
  git(root, "update-ref", "refs/remotes/origin/main", later);
  return { root, base, merged, later };
}

test("a cut merged after sibling PRs reports only its own files, never the start-era diff", (t) => {
  const { root, base, merged } = movingMain(t);
  // The execution started when the project HEAD sat at `base`; the sibling PR's file lies between
  // that observation and the merge commit, so the frozen-start diff would claim it (F-70FB11C4).
  const packet = derive(
    root,
    "Delivery complete.",
    undefined,
    ["ci"],
    undefined,
    { kind: "commit", commitSha: base },
    merged,
  );
  assert.equal(packet.commitSha, merged);
  assert.deepEqual(packet.deliverables, ["src/delivery.ts"]);
});

test("a cut named after main passed it reports its own files, never a reverse diff", (t) => {
  const { root, merged, later } = movingMain(t);
  // A restarted execution observed the project HEAD at `later`, a descendant of the named cut;
  // diffing from that observation reverses the comparison and credits the later PR's file.
  const packet = derive(
    root,
    "Delivery complete.",
    undefined,
    ["ci"],
    undefined,
    { kind: "commit", commitSha: later },
    merged,
  );
  assert.equal(packet.commitSha, merged);
  assert.deepEqual(packet.deliverables, ["src/delivery.ts"]);
});

test("one commit derives one manifest whatever start observation the execution froze", (t) => {
  const { root, base, merged, later } = movingMain(t);
  for (const deliveryBaseline of [
    { kind: "commit" as const, commitSha: base }, // started before the sibling PRs
    { kind: "commit" as const, commitSha: merged }, // restarted exactly at the cut (was the empty cut)
    { kind: "commit" as const, commitSha: later }, // restarted after publication
    { kind: "empty-tree" as const }, // observed before any commit existed
    null, // legacy execution started before the baseline field froze
  ])
    assert.deepEqual(
      derive(
        root,
        "Delivery complete.",
        undefined,
        ["ci"],
        undefined,
        deliveryBaseline,
        merged,
        "repository-diff",
        git(root, "rev-parse", `${merged}^2`),
      ).deliverables,
      ["src/delivery.ts"],
      `start observation ${JSON.stringify(deliveryBaseline)}`,
    );
});

test("a task without its own commit delivers accepted artifacts, not the baseline merge", (t) => {
  const { root, merged } = movingMain(t),
    worker = path.join(root, ".worktrees/task-1");
  git(root, "worktree", "add", "-qb", "task-1", worker, merged);
  const packet = derive(
    root,
    "Delivered artifact:artifacts/report.md@7.",
    undefined,
    ["ci"],
    artifactStore().store as Parameters<typeof deriveCloseoutSubmission>[0]["store"],
    { kind: "commit", commitSha: merged },
  );
  assert.deepEqual(packet.deliverables, []);
  assert.deepEqual(packet.outputs, [`Artifact-Anchor: ${packagePath}/artifacts/report.md@7`]);
  assert.equal(packet.artifacts?.length, 1);
  assert.deepEqual(
    derive(
      root,
      "Delivered artifact:artifacts/report.md@7.",
      undefined,
      ["ci"],
      artifactStore().store as Parameters<typeof deriveCloseoutSubmission>[0]["store"],
      null,
    ).deliverables,
    [],
  );
  const closeoutOnly = derive(root, "Completed ledger coordination.", undefined, ["ci"], undefined, {
    kind: "commit",
    commitSha: merged,
  });
  assert.equal(closeoutOnly.commitSha, merged);
  assert.deepEqual(closeoutOnly.deliverables, []);
  assert.deepEqual(closeoutOnly.outputs, []);
  assert.equal(closeoutOnly.artifacts, undefined);
});

test("a restarted task retains the first-parent diff for its earlier delivery ancestor", (t) => {
  const { root, merged } = movingMain(t),
    worker = path.join(root, ".worktrees/task-1"),
    delivery = git(root, "rev-parse", `${merged}^2`);
  git(root, "worktree", "add", "-qb", "task-1", worker, merged);
  for (const prior of [delivery, git(root, "rev-parse", `${delivery}^1`)]) {
    const packet = derive(
      root,
      "Re-delivered.",
      undefined,
      ["ci"],
      undefined,
      { kind: "commit", commitSha: merged },
      undefined,
      "repository-diff",
      prior,
    );
    assert.deepEqual(packet.deliverables, ["src/delivery.ts"]);
  }
  const foreignPrior = derive(
    root,
    "Foreign prior cut.",
    undefined,
    ["ci"],
    undefined,
    { kind: "commit", commitSha: merged },
    undefined,
    "repository-diff",
    git(root, "rev-parse", "HEAD"),
  );
  assert.equal(foreignPrior.commitSha, merged);
  assert.deepEqual(foreignPrior.deliverables, []);
  assert.deepEqual(foreignPrior.outputs, []);
  assert.equal(foreignPrior.artifacts, undefined);
});

test("documentation amendments pin new artifact bytes while unrelated ledger writes preserve the cut", (t) => {
  const { root, ledger } = fixture(t);
  const report = `${packagePath}/artifacts/report.md`;
  put(ledger, report, "First accepted report.\n");
  const firstSha = commit(ledger);
  const read = (frozen?: ReturnType<typeof deriveCloseoutSubmission>) =>
    derive(
      root,
      "Audited report.",
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      "task-package-artifact",
      undefined,
      frozen,
    );
  const first = read();
  assert.equal(first.commitSha, firstSha);
  put(ledger, "other-task/notes.md", "Unrelated accepted write.\n");
  commit(ledger);
  assert.equal(read(first).commitSha, firstSha, "unrelated publication must not invalidate review");
  const added = `${packagePath}/artifacts/new-evidence.md`;
  put(ledger, added, "New accepted evidence.\n");
  put(ledger, report, "Corrected report.\n");
  const amendedSha = commit(ledger);
  const amended = read(first);
  assert.equal(amended.commitSha, amendedSha);
  assert.ok(amended.deliverables.includes(added));
  for (const file of amended.deliverables) git(ledger, "cat-file", "-e", `${amended.commitSha}:${file}`);
  assert.equal(git(ledger, "show", `${amended.commitSha}:${report}`), "Corrected report.");
  put(ledger, `${packagePath}/executions/execution-1.md`, "Submission bookkeeping.\n");
  commit(ledger);
  assert.equal(read(amended).commitSha, amendedSha, "submission bookkeeping must not move its own cut");
});
