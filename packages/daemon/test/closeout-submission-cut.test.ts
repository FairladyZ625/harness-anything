// harness-test-tier: fast
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { submissionAnchorDriftWarnings, submissionStopped } from "../src/repo-cell-submit.ts";
import { deriveCloseoutSubmission, readCloseoutSubmission } from "./closeout-submission.fixture.ts";

import {
  packagePath,
  documentPath,
  git,
  put,
  commit,
  closeout,
  fixture,
  artifactStore,
  deriveInput,
  derive,
  dispatch,
} from "./closeout-submission-cut.fixture.ts";

test("explicit structured commit derives mixed deletion evidence without a dispatch", async (t) => {
  const { root } = fixture(t);
  rmSync(path.join(root, "src/old.ts"));
  put(root, "src/live.ts", "export const liveValue = 2;\n");
  const sha = commit(root),
    packet = await derive(root, "Delivered the implementation.", undefined, ["lint"], undefined, undefined, sha);
  assert.equal(packet.commitSha, sha);
  assert.deepEqual(packet.deliverables, ["src/live.ts"]);
  assert.deepEqual(packet.outputs, ["Deleted-Production-Paths: src/old.ts"]);
  assert.deepEqual(packet.knownGaps, ["已知缺口：publication pending.", "Sibling delivery remains unverified."]);
});

test("repository delivery automatically freezes accepted report without a Summary anchor", async (t) => {
  const { root } = fixture(t),
    { store, blobSha256 } = artifactStore();
  put(root, "src/live.ts", "export const liveValue = 6;\n");
  const sha = commit(root),
    packet = await derive(
      root,
      "Delivered the implementation and report.",
      undefined,
      ["lint", "signoff"],
      store,
      undefined,
      sha,
      "repository-diff",
      undefined,
      undefined,
      [{ path: `${packagePath}/artifacts/report.md`, revision: 7 }],
    );
  assert.equal(packet.commitSha, sha);
  assert.deepEqual(packet.artifacts, [{ path: `${packagePath}/artifacts/report.md`, revision: 7, blobSha256 }]);
  assert.deepEqual(packet.deliverables, ["src/live.ts"]);
});

test("pure deletion cut has no surviving anchor paths and keeps the deletion list", async (t) => {
  const { root } = fixture(t);
  rmSync(path.join(root, "src/old.ts"));
  const sha = commit(root),
    packet = await derive(root, "Delivered the deletion.", undefined, ["lint"], undefined, undefined, sha);
  assert.deepEqual(packet.deliverables, []);
  assert.deepEqual(packet.outputs, ["Deleted-Production-Paths: src/old.ts"]);
});

test("rename cut anchors the surviving target path", async (t) => {
  const { root } = fixture(t);
  git(root, "config", "diff.renames", "true");
  renameSync(path.join(root, "src/old.ts"), path.join(root, "src/renamed.ts"));
  const sha = commit(root),
    packet = await derive(root, "Delivered the rename.", undefined, ["lint"], undefined, undefined, sha);
  assert.deepEqual(packet.deliverables, ["src/renamed.ts"]);
  assert.deepEqual(packet.outputs, []);
});

test("task worktree HEAD is the delivery commit without a runtime dispatch", async (t) => {
  const { root } = fixture(t),
    worktree = path.join(root, ".worktrees/task-1");
  git(root, "worktree", "add", "-qb", "task-1", worktree);
  put(worktree, "src/live.ts", "export const liveValue = 4;\n");
  const sha = commit(worktree),
    old = git(root, "rev-parse", "HEAD");
  assert.equal(
    (await derive(root, `Completed the bound task worktree; prior cut was ${old}.`, undefined, ["lint"])).commitSha,
    sha,
  );
});

test("a rebase may advance the bound delivery commit without rewriting closeout prose", async (t) => {
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
  const submission = await derive(root, closeout, undefined, ["lint"]);
  assert.equal(submission.commitSha, afterRebase);
  assert.equal(submission.completionClaim, closeout);
});

test("lightweight task worktree HEAD is the delivery commit though its gate set is empty", async (t) => {
  const { root } = fixture(t),
    worktree = path.join(root, ".worktrees/task-1");
  git(root, "worktree", "add", "-qb", "task-1", worktree);
  put(worktree, "src/live.ts", "export const liveValue = 5;\n");
  const sha = commit(worktree),
    old = git(root, "rev-parse", "HEAD");
  // RED under the old completion-gate-based test: an empty gate set (the lightweight profile) used to
  // route this repository-diff task to the ledger outbox commit instead of the bound worktree HEAD.
  assert.equal(
    (await derive(root, `Completed the lightweight worktree; prior cut was ${old}.`, undefined, [])).commitSha,
    sha,
  );
});

test("missing dispatch requires an explicit structured delivery commit", async (t) => {
  const { root, base } = fixture(t);
  put(root, "src/live.ts", "export const liveValue = 3;\n");
  const sha = commit(root);
  await assert.rejects(async () => await derive(root, "Completed the live path."), { code: "invalid_submission" });
  assert.equal(
    (await derive(root, `Earlier cuts: ${base} and ${"f".repeat(40)}.`, undefined, ["lint"], undefined, undefined, sha))
      .commitSha,
    sha,
  );
});

test("an old dispatch cwd in another checkout never stands in for the bound worktree HEAD", async (t) => {
  const { root } = fixture(t),
    canonical = path.join(root, "canonical");
  // An earlier dispatch ran with --cwd pointed at another checkout; its HEAD is not this task's delivery.
  git(root, "worktree", "add", "-qb", "canonical", canonical);
  put(canonical, "src/foreign.ts", "foreign\n");
  commit(canonical);
  dispatch(root, canonical);
  await assert.rejects(async () => await derive(root, "Completed the live path."), {
    code: "invalid_submission",
    message: /No readable bound worktree HEAD exists; rerun with --commit/u,
  });
  put(root, "src/live.ts", "export const liveValue = 5;\n");
  const sha = commit(root);
  assert.equal((await derive(root, "Completed.", undefined, ["lint"], undefined, undefined, sha)).commitSha, sha);
});

test("a plain directory at the bound worktree path never lends the canonical HEAD", async (t) => {
  const { root } = fixture(t);
  // A leftover ordinary directory at .worktrees/task-1: rev-parse there walks up to the canonical checkout.
  put(root, ".worktrees/task-1/leftover.txt", "not a worktree\n");
  await assert.rejects(async () => await derive(root, "Completed the live path.", undefined, ["lint"]), {
    code: "invalid_submission",
    message: /No readable bound worktree HEAD exists; rerun with --commit/u,
  });
});

test("explicit delivery commit must match a bound worktree HEAD and reports both values", async (t) => {
  const { root, base } = fixture(t),
    worktree = path.join(root, ".worktrees/task-1");
  git(root, "worktree", "add", "-qb", "task-1", worktree);
  put(worktree, "src/live.ts", "export const liveValue = 3;\n");
  const head = commit(worktree);
  await assert.rejects(async () => await derive(root, "Complete.", undefined, ["lint"], undefined, undefined, base), {
    code: "invalid_submission",
    message: new RegExp(`${base}.*${head}`, "u"),
  });
});

test("a private Git commit cannot substitute for an artifact acceptance revision", async (t) => {
  const { root, ledger } = fixture(t);
  put(ledger, `${packagePath}/artifacts/report.md`, "Evidence.\n");
  const sha = commit(ledger);
  await assert.rejects(async () => await derive(root, `Delivered ${sha}.`), { code: "invalid_submission" });
});

test("missing ledger artifact paths and missing projected documents fail closed", async (t) => {
  const { root, ledger } = fixture(t);
  put(ledger, "tasks/task-2/artifacts/report.md", "Other evidence.\n");
  const sha = commit(ledger);
  await assert.rejects(async () => await derive(root, `Delivered ${sha}.`), { code: "invalid_submission" });
  for (const missing of [documentPath, `${packagePath}/task-contract.json`])
    await assert.rejects(
      async () =>
        await derive(
          root,
          `Delivered ${sha}.`,
          missing,
          ["lint"],
          undefined,
          undefined,
          git(root, "rev-parse", "HEAD"),
        ),
      { code: "content_not_ready" },
    );
  dispatch(root, path.join(root, "missing-worktree"));
  await assert.rejects(async () => await derive(root, "Completed the live path."), { code: "invalid_submission" });
});

test("shared public and authored Git root keeps a code delivery on its public cut", async (t) => {
  const { root } = fixture(t, true);
  put(root, "src/live.ts", "export const liveValue = 4;\n");
  const sha = commit(root),
    packet = await derive(root, "Delivered the implementation.", undefined, ["lint"], undefined, undefined, sha);
  assert.equal(packet.commitSha, sha);
  assert.deepEqual(packet.deliverables, ["src/live.ts"]);
});

test("unpublished bound worktree HEAD preserves every branch commit before main", async (t) => {
  const { root } = fixture(t);
  // The main checkout leaves the default branch below, so only origin/HEAD, as a clone records it, names main.
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const worktree = path.join(root, ".worktrees/task-1");
  git(root, "worktree", "add", "-qb", "task-1", worktree);
  put(worktree, "src/first.ts", "first\n");
  commit(worktree);
  put(worktree, "src/second.ts", "second\n");
  const head = commit(worktree),
    packet = await derive(root, "Worktree delivery.", undefined, ["lint"]);
  assert.deepEqual(packet.deliverables, ["src/first.ts", "src/second.ts"]);
  assert.equal(packet.commitSha, head);
});

test("removed dispatch worktree resolves an explicit delivery cut in the canonical repository", async (t) => {
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
  assert.equal(
    (await derive(root, "Delivery complete.", undefined, ["lint"], undefined, undefined, merged)).commitSha,
    merged,
  );
  assert.deepEqual(
    (await derive(root, "Delivery complete.", undefined, ["lint"], undefined, undefined, merged)).deliverables,
    ["src/delivery.ts"],
  );
  await assert.rejects(async () => await derive(root, "Delivery complete."), /No readable bound worktree HEAD/u);
  await assert.rejects(
    async () => await derive(root, "Delivery complete.", undefined, ["lint"], undefined, undefined, "f".repeat(40)),
    /not in any local clone/u,
  );
  put(root, "src/unpublished.ts", "unpublished\n");
  const unpublished = commit(root);
  assert.equal(
    (await derive(root, "Delivery complete.", undefined, ["lint"], undefined, undefined, unpublished)).commitSha,
    unpublished,
  );
});

test("one execution with two dispatch directories and no bound worktree names no delivery from Summary prose", async (t) => {
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
  await assert.rejects(
    async () => await derive(root, `Unrelated published merge ${merged}.`),
    /No readable bound worktree HEAD/u,
  );
});

test("a structured commit differing from the bound HEAD is rejected", async (t) => {
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
  await assert.rejects(
    async () => await derive(root, "Delivery complete.", undefined, ["lint"], undefined, undefined, merged),
    /does not match bound worktree HEAD/u,
  );
});

test("documentation task ignores unrelated Summary SHA and freezes accepted artifacts", async (t) => {
  const { root, ledger } = fixture(t);
  put(ledger, `${packagePath}/artifacts/report.md`, "Evidence.\n");
  commit(ledger);
  const packet = await derive(
    root,
    `Audited unrelated PR ${"f".repeat(40)}.`,
    undefined,
    [],
    artifactStore().store as unknown as Parameters<typeof deriveCloseoutSubmission>[0]["store"],
    undefined,
    undefined,
    "task-package-artifact",
    undefined,
    undefined,
    [{ path: `${packagePath}/artifacts/report.md`, revision: 7 }],
  );
  assert.equal(packet.commitSha, null);
  assert.equal(packet.artifacts![0]!.revision, 7);
  assert.deepEqual(packet.deliverables, [`${packagePath}/artifacts/report.md`]);
  assert.deepEqual(packet.outputs, []);
});

// Negative control (dec_BBA713052997C3EF5F5D3DD952): a task-package-artifact task keeps its ledger delivery
// even with a non-empty gate set, proving the shape-based determinant never keyed private delivery to gates.
test("a task-package-artifact task freezes accepted artifacts with a non-empty gate set", async (t) => {
  const { root, ledger } = fixture(t);
  put(ledger, `${packagePath}/artifacts/report.md`, "Evidence.\n");
  commit(ledger);
  const packet = await derive(
    root,
    `Audited unrelated PR ${"f".repeat(40)}.`,
    undefined,
    ["lint", "signoff"],
    artifactStore().store as unknown as Parameters<typeof deriveCloseoutSubmission>[0]["store"],
    undefined,
    undefined,
    "task-package-artifact",
    undefined,
    undefined,
    [{ path: `${packagePath}/artifacts/report.md`, revision: 7 }],
  );
  assert.equal(packet.commitSha, null);
  assert.equal(packet.artifacts![0]!.revision, 7);
  assert.deepEqual(packet.deliverables, [`${packagePath}/artifacts/report.md`]);
});

test("implicit delivery fails closed when the task has no accepted artifacts", async (t) => {
  const { root } = fixture(t);
  git(root, "commit", "-q", "--allow-empty", "-m", "test: empty product cut");
  const empty = git(root, "rev-parse", "HEAD");
  dispatch(root, root);
  await assert.rejects(
    async () =>
      await derive(
        root,
        `Delivered ${empty}.`,
        undefined,
        [],
        undefined,
        undefined,
        undefined,
        "task-package-artifact",
      ),
    { code: "invalid_submission", message: /artifacts/u },
  );
});

test("an artifactless private delivery guides the next action at artifacts/, not closeout.md", async (t) => {
  const { root } = fixture(t);
  const stop = (error: unknown) =>
    submissionStopped(
      {
        rejected: (opId: string, code: string) => ({ opId, outcome: "op_rejected", code }),
        operationId: () => "op-stop-1",
        input: { repoId: "repo-stop" },
      } as unknown as Parameters<typeof submissionStopped>[0],
      { kind: "task-submit", taskId: "task-1" } as unknown as Parameters<typeof submissionStopped>[1],
      {} as Parameters<typeof submissionStopped>[2],
      {
        revision: 3,
        lease: null,
        reviews: [],
        executions: [],
        task: { createdBy: { principal: { personId: "owner" } }, iteration: 1 },
      } as unknown as Parameters<typeof submissionStopped>[3],
      "execution-1",
      packagePath,
      error,
    ) as { readonly code: string; readonly next: readonly { readonly action: string }[] };
  let thrown: unknown;
  try {
    await derive(
      root,
      "Delivered nothing yet.",
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      "task-package-artifact",
    );
    assert.fail("the artifactless private delivery must stop");
  } catch (error) {
    thrown = error;
  }
  const receipt = stop(thrown);
  assert.equal(receipt.code, "document_invalid");
  assert.deepEqual(
    receipt.next.map(({ action }) => action),
    [
      `Write the deliverable into harness/${packagePath}/artifacts/ (closeout.md and runtime reports are not deliverables), ` +
        `then run ha task submit task-1.`,
    ],
  );
  // Control: every stop whose guard carries no remedy of its own keeps the closeout-first guidance.
  assert.deepEqual(
    stop(
      Object.assign(new Error("Requested delivery commit a does not match bound worktree HEAD b."), {
        code: "invalid_submission",
      }),
    ).next.map(({ action }) => action),
    [`Fill harness/${packagePath}/closeout.md, then run ha task submit task-1.`],
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

test("a root-commit delivery on an unborn repository diffs against the empty tree", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-closeout-unborn-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Harness Test");
  git(root, "config", "user.email", "harness@example.test");
  put(root, "src/first.ts", "export const first = 1;\n");
  const sha = commit(root);
  const packet = await derive(root, `Delivered ${sha}.`, undefined, ["lint"], undefined, { kind: "empty-tree" }, sha);
  assert.equal(packet.commitSha, sha);
  assert.deepEqual(packet.deliverables, ["src/first.ts"]);
});

test("a multi-commit delivery lists every path changed since the frozen baseline", async (t) => {
  const { root } = fixture(t);
  put(root, "src/first.ts", "first\n");
  commit(root);
  put(root, "src/second.ts", "second\n");
  const sha = commit(root);
  const packet = await derive(root, `Delivered ${sha}.`, undefined, ["lint"], undefined, undefined, sha);
  assert.equal(packet.commitSha, sha);
  assert.deepEqual(packet.deliverables, ["src/first.ts", "src/second.ts"]);
});

test("submission facts freeze the full changed-path set and G33 result at the delivery base", async (t) => {
  const { root, base } = fixture(t);
  put(root, "docs/retired.md", "retired documentation\n");
  put(root, "packages/kernel/src/retired.ts", "export const retired = 1;\n");
  const deliveryBase = commit(root);
  git(root, "update-ref", "refs/remotes/origin/main", deliveryBase);
  git(root, "checkout", "-q", "-b", "feature");
  put(root, "docs/new.md", "new documentation\n");
  put(root, "packages/kernel/src/added.ts", "export const first = 1;\nexport const second = 2;\n");
  git(root, "rm", "-q", "docs/retired.md", "packages/kernel/src/retired.ts");
  const sha = commit(root),
    packet = await derive(
      root,
      `Delivered ${sha}.`,
      undefined,
      ["lint"],
      undefined,
      { kind: "commit", commitSha: base },
      sha,
    );

  assert.deepEqual(packet.changedFiles, [
    "docs/new.md",
    "docs/retired.md",
    "packages/kernel/src/added.ts",
    "packages/kernel/src/retired.ts",
  ]);
  assert.deepEqual(packet.productionDelta, {
    baseSha: deliveryBase,
    added: 2,
    deleted: 1,
    changed: [
      { filePath: "packages/kernel/src/added.ts", module: "kernel", added: 2, deleted: 0 },
      { filePath: "packages/kernel/src/retired.ts", module: "kernel", added: 0, deleted: 1 },
    ],
    unclassified: [],
  });
});

test("a reworked cut recomputes production delta from its new commit, not the previous submission", async (t) => {
  const { root } = fixture(t);
  put(root, "packages/daemon/src/retired.ts", "export const retired = 1;\n");
  put(root, "packages/storage/src/keep.ts", "export const keep = 1;\n");
  const mainBase = commit(root);
  git(root, "update-ref", "refs/remotes/origin/main", mainBase);
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(root, "checkout", "-q", "-b", "feature");
  put(root, "packages/daemon/src/runtime.ts", "export const runtime = 1;\n");
  git(root, "rm", "-q", "packages/daemon/src/retired.ts");
  const firstSha = commit(root),
    first = await derive(
      root,
      `Delivered ${firstSha}.`,
      undefined,
      ["lint"],
      undefined,
      { kind: "commit", commitSha: mainBase },
      firstSha,
    );
  assert.deepEqual([first.productionDelta?.added, first.productionDelta?.deleted], [1, 1]);

  put(root, "packages/storage/src/keep.ts", "export const keep = 2;\nexport const extra = 3;\n");
  put(root, "packages/storage/src/rework.ts", "export const rework = 1;\n");
  put(root, "packages/daemon/src/follow-up.ts", "export const follow = 1;\nexport const up = 2;\n");
  const secondSha = commit(root),
    second = await derive(
      root,
      `Reworked ${secondSha}.`,
      undefined,
      ["lint"],
      undefined,
      { kind: "commit", commitSha: mainBase },
      secondSha,
      "repository-diff",
      undefined,
      first,
    ),
    expected = git(root, "diff", "--no-renames", "--numstat", mainBase, secondSha, "--")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [added, deleted, filePath] = line.split("\t");
        return { added: Number(added), deleted: Number(deleted), filePath };
      })
      .filter(({ filePath }) => /^packages\/(?:daemon|storage)\/src\//u.test(filePath));

  assert.notEqual(second.commitSha, first.commitSha);
  assert.deepEqual(
    [second.productionDelta?.added, second.productionDelta?.deleted],
    [expected.reduce((sum, entry) => sum + entry.added, 0), expected.reduce((sum, entry) => sum + entry.deleted, 0)],
  );
  assert.deepEqual([...new Set(second.productionDelta?.changed.map(({ module }) => module))].sort(), [
    "daemon",
    "storage",
  ]);
});

test("amending the same legacy commit recomputes missing submission facts", async (t) => {
  const { root, base } = fixture(t);
  put(root, "packages/kernel/src/new.ts", "export const added = 1;\n");
  const sha = commit(root),
    first = await derive(
      root,
      "Delivered the change.",
      undefined,
      ["lint"],
      undefined,
      { kind: "commit", commitSha: base },
      sha,
    ),
    legacyFrozen = Object.fromEntries(
      Object.entries(first).filter(([key]) => !["changedFiles", "productionDelta"].includes(key)),
    ) as Awaited<ReturnType<typeof deriveCloseoutSubmission>>,
    amended = await derive(
      root,
      "Amended the legacy cut.",
      undefined,
      ["lint"],
      undefined,
      { kind: "commit", commitSha: base },
      sha,
      "repository-diff",
      undefined,
      legacyFrozen,
    );
  assert.equal(amended.commitSha, sha);
  assert.deepEqual(amended.changedFiles, ["packages/kernel/src/new.ts"]);
  assert.equal(amended.productionDelta?.baseSha, base);
  assert.equal(amended.productionDelta?.added, 1);
});

test("re-freezing after rebase fetches a stale origin main and excludes its paths", async (t) => {
  const { root, base } = fixture(t),
    origin = mkdtempSync(path.join(tmpdir(), "ha-closeout-origin-")),
    upstream = mkdtempSync(path.join(tmpdir(), "ha-closeout-upstream-"));
  t.after(() => rmSync(origin, { recursive: true, force: true }));
  t.after(() => rmSync(upstream, { recursive: true, force: true }));
  git(origin, "init", "--bare", "-q", "--initial-branch=main");
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "-q", "--set-upstream", "origin", "main");
  git(root, "fetch", "--quiet", "origin", "refs/heads/main:refs/remotes/origin/main");
  git(root, "remote", "set-head", "origin", "main");
  const staleMain = git(root, "rev-parse", "origin/main");

  git(root, "checkout", "-q", "-b", "feature");
  put(root, "packages/kernel/src/own.ts", "export const own = 1;\n");
  commit(root);
  git(upstream, "clone", "-q", origin, upstream);
  git(upstream, "config", "user.name", "Harness Test");
  git(upstream, "config", "user.email", "harness@example.test");
  put(upstream, "packages/kernel/src/foreign.ts", "export const foreign = 1;\n");
  const advancedMain = commit(upstream);
  git(upstream, "push", "-q", "origin", "main");

  // Rebase on a newly fetched object without refreshing this checkout's origin/main ref.
  git(root, "remote", "add", "rebase-source", origin);
  git(root, "fetch", "--quiet", "rebase-source", "refs/heads/main:refs/heads/rebase-target");
  assert.equal(git(root, "rev-parse", "origin/main"), staleMain);
  git(root, "rebase", "--quiet", "rebase-target");
  const rebasedCommit = git(root, "rev-parse", "HEAD"),
    result = await readCloseoutSubmission(
      ...deriveInput(
        root,
        "Re-froze after rebase.",
        undefined,
        ["lint"],
        undefined,
        { kind: "commit", commitSha: base },
        rebasedCommit,
      ),
    );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.notEqual(rebasedCommit, git(root, "rev-parse", "refs/remotes/origin/main"));
  assert.deepEqual(result.submission.changedFiles, ["packages/kernel/src/own.ts"]);
  assert.equal(result.submission.productionDelta?.baseSha, advancedMain);
  assert.equal(result.submission.productionDelta?.added, 1);
});

function submitCloseoutBody(root: string, sha: string, body: string) {
  return readCloseoutSubmission(
    ...deriveInput(
      root,
      "Delivered.",
      undefined,
      ["lint"],
      undefined,
      undefined,
      sha,
      "repository-diff",
      undefined,
      undefined,
      [],
      [],
      [],
      body,
    ),
  );
}

test("submit accepts the original Event-Migration import and the client-local migrate commands", async (t) => {
  const { root } = fixture(t);
  put(root, "packages/kernel/fixtures/canonical-events/example/accepted.json", "{}\n");
  put(root, "src/live.ts", "export const liveValue = 2;\n");
  const sha = commit(root),
    base = closeout("Delivered.");
  for (const name of ["import", "ledger", "completion", "agent-declaration", "writer-epoch"]) {
    const body = base.replace("Tests passed.", `Tests passed.\nEvent-Migration: ha migrate ${name}`),
      result = await submitCloseoutBody(root, sha, body);
    assert.equal(result.ok, true, `${name}: actual submit accepts the declaration`);
  }
});

test("an execution started before the baseline froze keeps the comparison cut in force when it started", async (t) => {
  const { root } = fixture(t);
  put(root, "src/earlier.ts", "export const earlierValue = 8;\n");
  commit(root);
  put(root, "src/live.ts", "export const liveValue = 9;\n");
  const sha = commit(root);
  // The pre-freeze rule compares against the merge base with origin/main, so both commits are delivered.
  const packet = await derive(root, `Delivered ${sha}.`, undefined, ["lint"], undefined, null, sha);
  assert.equal(packet.commitSha, sha);
  assert.deepEqual(packet.deliverables, ["src/earlier.ts", "src/live.ts"]);
});

test("a frozen baseline unreadable in an unanchored repository fails closed", async (t) => {
  const { root } = fixture(t);
  // Only repositories without a default branch consult the frozen observation: no remote, and the main
  // checkout on a detached HEAD.
  git(root, "update-ref", "-d", "refs/remotes/origin/main");
  git(root, "checkout", "-q", "--detach");
  put(root, "src/live.ts", "export const liveValue = 10;\n");
  const sha = commit(root);
  await assert.rejects(
    async () =>
      await derive(
        root,
        `Delivered ${sha}.`,
        undefined,
        ["lint"],
        undefined,
        { kind: "commit", commitSha: "f".repeat(40) },
        sha,
      ),
    { code: "invalid_submission", message: /not readable/u },
  );
});

test("a repository without a remote anchors its cut on the local default branch, not the start observation", async (t) => {
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
    (await derive(root, "Delivered the worker cut.", undefined, ["lint"], undefined, started, delivery)).deliverables,
    ["src/delivery.ts"],
  );
  // Delivered straight onto main after more ledger writes: the cut is that commit's own change.
  put(root, "ledger/INDEX.md", "published a third time\n");
  commit(root);
  put(root, "src/direct.ts", "direct\n");
  const direct = commit(root);
  git(root, "worktree", "remove", worker);
  assert.deepEqual(
    (await derive(root, "Delivered the direct cut.", undefined, ["lint"], undefined, started, direct)).deliverables,
    ["src/direct.ts"],
  );
});

test("the comparison cut follows the delivery fork point, not the project HEAD at start", async (t) => {
  const { root, base } = fixture(t);
  put(root, "src/delivery.ts", "delivery\n");
  const sha = commit(root);
  // The execution's start observation (base) predates the delivery; only the fork point counts.
  const packet = await derive(
    root,
    `Delivered ${sha}.`,
    undefined,
    ["lint"],
    undefined,
    { kind: "commit", commitSha: base },
    sha,
  );
  assert.deepEqual(packet.deliverables, ["src/delivery.ts"]);
});
