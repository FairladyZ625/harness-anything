// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { sha256Bytes } from "@harness-anything/kernel";

import { deriveCloseoutSubmission } from "./closeout-submission.fixture.ts";
import { reviewPathHits, reviewPathRules } from "../src/review-path-matching.ts";
import { packagePath, git, put, commit, fixture, artifactStore, derive } from "./closeout-submission-cut.fixture.ts";

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

test("a cut merged after sibling PRs reports only its own files, never the start-era diff", async (t) => {
  const { root, base, merged } = movingMain(t);
  // The execution started when the project HEAD sat at `base`; the sibling PR's file lies between
  // that observation and the merge commit, so the frozen-start diff would claim it (F-70FB11C4).
  const packet = await derive(
    root,
    "Delivery complete.",
    undefined,
    ["lint"],
    undefined,
    { kind: "commit", commitSha: base },
    merged,
  );
  assert.equal(packet.commitSha, merged);
  assert.deepEqual(packet.deliverables, ["src/delivery.ts"]);
});

test("a cut named after main passed it reports its own files, never a reverse diff", async (t) => {
  const { root, merged, later } = movingMain(t);
  // A restarted execution observed the project HEAD at `later`, a descendant of the named cut;
  // diffing from that observation reverses the comparison and credits the later PR's file.
  const packet = await derive(
    root,
    "Delivery complete.",
    undefined,
    ["lint"],
    undefined,
    { kind: "commit", commitSha: later },
    merged,
  );
  assert.equal(packet.commitSha, merged);
  assert.deepEqual(packet.deliverables, ["src/delivery.ts"]);
});

test("one commit derives one manifest whatever start observation the execution froze", async (t) => {
  const { root, base, merged, later } = movingMain(t);
  for (const deliveryBaseline of [
    { kind: "commit" as const, commitSha: base }, // started before the sibling PRs
    { kind: "commit" as const, commitSha: merged }, // restarted exactly at the cut (was the empty cut)
    { kind: "commit" as const, commitSha: later }, // restarted after publication
    { kind: "empty-tree" as const }, // observed before any commit existed
    null, // legacy execution started before the baseline field froze
  ])
    assert.deepEqual(
      (
        await derive(
          root,
          "Delivery complete.",
          undefined,
          ["lint"],
          undefined,
          deliveryBaseline,
          merged,
          "repository-diff",
          git(root, "rev-parse", `${merged}^2`),
        )
      ).deliverables,
      ["src/delivery.ts"],
      `start observation ${JSON.stringify(deliveryBaseline)}`,
    );
});

test("a task without its own commit delivers accepted artifacts, not the baseline merge", async (t) => {
  const { root, merged } = movingMain(t),
    worker = path.join(root, ".worktrees/task-1");
  git(root, "worktree", "add", "-qb", "task-1", worker, merged);
  const packet = await derive(
    root,
    "Delivered artifact:artifacts/report.md@7.",
    undefined,
    ["lint"],
    artifactStore().store as Parameters<typeof deriveCloseoutSubmission>[0]["store"],
    { kind: "commit", commitSha: merged },
    undefined,
    "repository-diff",
    undefined,
    undefined,
    [{ path: `${packagePath}/artifacts/report.md`, revision: 7 }],
  );
  assert.deepEqual(packet.deliverables, []);
  assert.deepEqual(packet.outputs, []);
  assert.equal(packet.artifacts?.length, 1);
  assert.deepEqual(
    (
      await derive(
        root,
        "Delivered artifact:artifacts/report.md@7.",
        undefined,
        ["lint"],
        artifactStore().store as Parameters<typeof deriveCloseoutSubmission>[0]["store"],
        null,
        undefined,
        "repository-diff",
        undefined,
        undefined,
        [{ path: `${packagePath}/artifacts/report.md`, revision: 7 }],
      )
    ).deliverables,
    [],
  );
  const closeoutOnly = await derive(root, "Completed ledger coordination.", undefined, ["lint"], undefined, {
    kind: "commit",
    commitSha: merged,
  });
  assert.equal(closeoutOnly.commitSha, null);
  assert.deepEqual(closeoutOnly.deliverables, []);
  assert.deepEqual(closeoutOnly.outputs, []);
  assert.deepEqual(closeoutOnly.artifacts, []);
});

test("a restarted task retains the first-parent diff for its earlier delivery ancestor", async (t) => {
  const { root, merged } = movingMain(t),
    worker = path.join(root, ".worktrees/task-1"),
    delivery = git(root, "rev-parse", `${merged}^2`);
  git(root, "worktree", "add", "-qb", "task-1", worker, merged);
  const packet = await derive(
    root,
    "Re-delivered.",
    undefined,
    ["lint"],
    undefined,
    { kind: "commit", commitSha: merged },
    undefined,
    "repository-diff",
    delivery,
  );
  assert.deepEqual(packet.deliverables, ["src/delivery.ts"]);
  // The commit below the delivery tip is the fork point on old main: reachable from the merged
  // branch, yet not introduced by the merge, so it evidences no delivery of this task.
  const forkPointPrior = await derive(
    root,
    "Prior cut named an old main commit.",
    undefined,
    ["lint"],
    undefined,
    { kind: "commit", commitSha: merged },
    undefined,
    "repository-diff",
    git(root, "rev-parse", `${delivery}^1`),
  );
  assert.deepEqual(forkPointPrior.deliverables, []);
  assert.deepEqual(forkPointPrior.outputs, []);
  assert.deepEqual(forkPointPrior.artifacts, []);
  const foreignPrior = await derive(
    root,
    "Foreign prior cut.",
    undefined,
    ["lint"],
    undefined,
    { kind: "commit", commitSha: merged },
    undefined,
    "repository-diff",
    git(root, "rev-parse", "HEAD"),
  );
  assert.equal(foreignPrior.commitSha, null);
  assert.deepEqual(foreignPrior.deliverables, []);
  assert.deepEqual(foreignPrior.outputs, []);
  assert.deepEqual(foreignPrior.artifacts, []);
});

/** A stale-checkout world: the bound task worktree sits at another PR's merge behind an advanced main. */
function foreignMerge(t: TestContext) {
  const { root } = fixture(t);
  const branch = path.join(root, "foreign");
  git(root, "worktree", "add", "-qb", "foreign/pr", branch);
  put(branch, "src/foreign-pr.ts", "foreign\n");
  commit(branch);
  git(root, "merge", "--no-ff", "-qm", "test: merge foreign PR", "foreign/pr");
  const stale = git(root, "rev-parse", "HEAD");
  // Main advances past the foreign merge while the task checkout never moves.
  put(root, "src/later-pr.ts", "later\n");
  const later = commit(root);
  git(root, "update-ref", "refs/remotes/origin/main", later);
  git(root, "worktree", "remove", branch);
  const worker = path.join(root, ".worktrees/task-1");
  git(root, "worktree", "add", "-qb", "task-1", worker, stale);
  return { root, stale, later };
}

test("a stale worktree HEAD behind the frozen baseline claims no foreign merge files", async (t) => {
  const { root, later } = foreignMerge(t);
  const packet = await derive(root, "Review-only round with no repository work.", undefined, ["lint"], undefined, {
    kind: "commit",
    commitSha: later,
  });
  assert.equal(packet.commitSha, null);
  assert.deepEqual(packet.deliverables, []);
  assert.deepEqual(packet.outputs, []);
});

test("a prior cut that only recorded the stale merge inherits nothing on resubmit", async (t) => {
  const { root, stale, later } = foreignMerge(t);
  const packet = await derive(
    root,
    "Second review round.",
    undefined,
    ["lint"],
    undefined,
    { kind: "commit", commitSha: later },
    undefined,
    "repository-diff",
    stale,
  );
  assert.equal(packet.commitSha, null);
  assert.deepEqual(packet.deliverables, []);
  assert.deepEqual(packet.outputs, []);
});

// Negative control: the restarted checkout sits at this task's own merge behind an advanced
// baseline, and the earlier cut recorded the merged branch tip — the manifest must survive.
test("a restarted delivery whose own branch merged keeps its manifest under an advanced baseline", async (t) => {
  const { root, merged, later } = movingMain(t),
    worker = path.join(root, ".worktrees/task-1");
  git(root, "worktree", "add", "-qb", "task-1", worker, merged);
  const packet = await derive(
    root,
    "Re-delivered after restart.",
    undefined,
    ["lint"],
    undefined,
    { kind: "commit", commitSha: later },
    undefined,
    "repository-diff",
    git(root, "rev-parse", `${merged}^2`),
  );
  assert.equal(packet.commitSha, merged);
  assert.deepEqual(packet.deliverables, ["src/delivery.ts"]);
});

test("documentation amendments pin new accepted bytes while unrelated publication preserves the cut", async (t) => {
  const { root, ledger } = fixture(t),
    report = `${packagePath}/artifacts/report.md`,
    added = `${packagePath}/artifacts/new-evidence.md`,
    bodies = new Map([[7, new Map([[report, "First accepted report.\n"]])]]);
  let accepted = [{ path: report, revision: 7 }];
  const store = {
    readEventAtRevision: (revision: number) => ({
      schema: "doc-event/v1",
      workspaceRevision: revision,
      opId: `accept-${revision}`,
      payload: {
        changes: [...bodies.get(revision)!].map(([path, body]) => ({
          path,
          candidate: { sha256: sha256Bytes(Buffer.from(body)) },
        })),
      },
    }),
    readContentBlob: (hash: string) => {
      for (const documents of bodies.values())
        for (const body of documents.values()) if (sha256Bytes(Buffer.from(body)) === hash) return Buffer.from(body);
      return null;
    },
    readContentBlobRange: (hash: string, offset: number, maxBytes: number) => {
      for (const documents of bodies.values())
        for (const body of documents.values())
          if (sha256Bytes(Buffer.from(body)) === hash) return Buffer.from(body).subarray(offset, offset + maxBytes);
      return null;
    },
    readContentBlobSize: (hash: string) => {
      for (const documents of bodies.values())
        for (const body of documents.values())
          if (sha256Bytes(Buffer.from(body)) === hash) return Buffer.byteLength(body);
      return null;
    },
  } as unknown as Parameters<typeof deriveCloseoutSubmission>[0]["store"];
  const read = async (frozen?: Awaited<ReturnType<typeof deriveCloseoutSubmission>>) =>
    await derive(
      root,
      "Audited report.",
      undefined,
      [],
      store,
      undefined,
      undefined,
      "task-package-artifact",
      undefined,
      frozen,
      accepted,
    );
  const first = await read();
  put(ledger, "other-task/notes.md", "Unrelated publication.\n");
  commit(ledger);
  assert.deepEqual(await read(first), first);
  bodies.set(
    8,
    new Map([
      [report, "Corrected report.\n"],
      [added, "New accepted evidence.\n"],
    ]),
  );
  accepted = [
    { path: report, revision: 8 },
    { path: added, revision: 8 },
  ];
  const amended = await read(first);
  assert.equal(amended.commitSha, null);
  assert.ok(amended.deliverables.includes(added));
  assert.notEqual(
    amended.artifacts!.find((anchor) => anchor.path === report)!.blobSha256,
    first.artifacts![0]!.blobSha256,
  );
  put(ledger, `${packagePath}/executions/execution-1.md`, "Submission bookkeeping.\n");
  commit(ledger);
  assert.deepEqual(await read(amended), amended);
});

test("implicit delivery excludes another task and independent reviewer credentials", async (t) => {
  const { root } = fixture(t),
    report = `${packagePath}/artifacts/report.md`,
    reviewerReport = `${packagePath}/artifacts/reports/old.md`;
  const packet = await derive(
    root,
    "Completed report.",
    undefined,
    [],
    artifactStore().store as unknown as Parameters<typeof deriveCloseoutSubmission>[0]["store"],
    undefined,
    undefined,
    "task-package-artifact",
    undefined,
    undefined,
    [
      { path: report, revision: 7 },
      { path: `${packagePath}/artifacts/reports/authored.md`, revision: 7 },
      { path: `${packagePath}/artifacts/.gitkeep`, revision: 1 },
      { path: "tasks/other/artifacts/report.md", revision: 7 },
      { path: reviewerReport, revision: 7 },
      { path: reviewerReport.replace(/md$/u, "json"), revision: 7 },
      { path: `${packagePath}/artifacts/reports/dispatch_pending.md`, revision: 7 },
    ],
    [{ reviewId: "review-old" }],
    ["dispatch_pending"],
  );
  assert.deepEqual(packet.deliverables, [report, `${packagePath}/artifacts/reports/authored.md`]);
});

test("stacked delivery uses its approved baseline for merged files and deletions, excluding upstream files", async (t) => {
  const { root } = fixture(t);
  git(root, "checkout", "-qb", "upstream");
  put(root, "src/upstream.ts", "approved upstream\n");
  const anchor = commit(root);
  git(root, "checkout", "main");
  put(root, "src/live.ts", "main advances\n");
  git(root, "rm", "src/old.ts");
  const main = commit(root);
  git(root, "update-ref", "refs/remotes/origin/main", main);
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(root, "checkout", "-qb", "integration", anchor);
  git(root, "merge", "--no-ff", "main", "-m", "test: CEO merges main");
  put(root, "src/ceo.ts", "CEO contribution\n");
  const delivery = commit(root);
  const packet = await derive(
    root,
    "Integrated delivery.",
    undefined,
    ["lint"],
    undefined,
    {
      kind: "commit",
      commitSha: anchor,
      stackOn: { taskId: "upstream", executionId: "exe-upstream" },
    },
    delivery,
  );
  assert.deepEqual(packet.deliverables, ["src/ceo.ts", "src/live.ts"]);
  assert.deepEqual(packet.outputs, ["Deleted-Production-Paths: src/old.ts"]);
  assert.equal(packet.commitSha, delivery);
  assert.deepEqual(
    (
      await derive(
        root,
        "Ordinary delivery.",
        undefined,
        ["lint"],
        undefined,
        {
          kind: "commit",
          commitSha: anchor,
        },
        delivery,
      )
    ).deliverables,
    ["src/ceo.ts", "src/upstream.ts"],
  );
});

// -- an empty task branch rebased onto an advanced main (task_96720a8e) ------------------------
/**
 * A zero-commit delivery branch rebased onto main that advanced after the execution started: the
 * branch tip IS main's tip, a merge commit another task's PR produced. The frozen baseline sits
 * behind it, so the checkout did "move", but no commit in the range belongs to this task.
 */
function emptyBranchOnAdvancedMain(t: TestContext) {
  const { root, base } = fixture(t);
  // Another task's PR lands on main after this execution started.
  git(root, "checkout", "-qb", "foreign/pr");
  put(root, "packages/storage/src/store/foreign-migration.ts", "export const foreignMigration = 1;\n");
  commit(root);
  git(root, "checkout", "-q", "main");
  git(root, "merge", "--no-ff", "-qm", "Merge pull request #3859 from other/task_9777b4a1", "foreign/pr");
  const merged = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", merged);
  // The task's own branch carries no commit of its own; the pre-handoff rebase makes its tip main's.
  const worker = path.join(root, ".worktrees/task-1");
  git(root, "worktree", "add", "-qb", "task-1", worker, base);
  git(worker, "rebase", "--quiet", "origin/main");
  return { root, base, merged, worker, branchTip: git(worker, "rev-parse", "HEAD") };
}

test("an artifact-only cut whose empty branch rebased onto an advanced main freezes no foreign files", async (t) => {
  const { root, base, merged, branchTip } = emptyBranchOnAdvancedMain(t),
    packet = await derive(root, "Analysis delivered as accepted artifacts.", undefined, [], undefined, {
      kind: "commit",
      commitSha: base,
    });
  assert.equal(branchTip, merged);
  // RED: the published-cut first-parent rule used to adopt #3859's whole manifest here.
  assert.equal(packet.commitSha, null);
  assert.deepEqual(packet.deliverables, []);
  assert.deepEqual(packet.outputs, []);
});

test("the artifact-only cut drives no path-review lane while the same mechanism still fires for its own migration commit", async (t) => {
  const { root, base, worker } = emptyBranchOnAdvancedMain(t),
    laneEntries = ["data-migration packages/storage/src/store/"],
    lanes = reviewPathRules(laneEntries),
    emptyCut = await derive(root, "Analysis delivered as accepted artifacts.", undefined, [], undefined, {
      kind: "commit",
      commitSha: base,
    });
  assert.equal(reviewPathHits(emptyCut, lanes).size, 0);
  // Positive control: a real persisted-shape change on the task's own branch still hits the lane.
  put(worker, "packages/storage/src/store/own-migration.ts", "export const ownMigration = 1;\n");
  commit(worker);
  const realCut = await derive(root, "Migrated the stored shape.", undefined, [], undefined, {
    kind: "commit",
    commitSha: base,
  });
  assert.deepEqual(realCut.deliverables, ["packages/storage/src/store/own-migration.ts"]);
  assert.equal(reviewPathHits(realCut, lanes).get("data-migration")?.length, 1);
});

// Positive control for the same gate: a real delivery already merged into main keeps its own
// first-parent manifest when the execution re-derives it after the merge, with no --commit.
test("an inferred re-derivation at this task's own merged tip keeps its first-parent manifest", async (t) => {
  const { root } = fixture(t),
    // This task's PR merges into main; its branch tip is the merge's second parent.
    branch = path.join(root, "own"),
    worker = path.join(root, ".worktrees/task-1");
  git(root, "worktree", "add", "-qb", "own/pr", branch);
  put(branch, "src/own-delivery.ts", "own\n");
  commit(branch);
  git(root, "merge", "--no-ff", "-qm", "Merge pull request #1 from x/task-1", "own/pr");
  const merged = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", merged);
  git(root, "worktree", "remove", branch);
  git(root, "worktree", "add", "-qb", "task-1", worker, merged);
  // No --commit: the bound worktree HEAD is the merged tip, the execution started before main
  // advanced to it, and the earlier cut recorded this task's own merged branch.
  const packet = await derive(
    root,
    "Re-derived the merged delivery.",
    undefined,
    [],
    undefined,
    { kind: "commit", commitSha: git(root, "rev-parse", `${merged}^1`) },
    undefined,
    "repository-diff",
    git(root, "rev-parse", `${merged}^2`),
  );
  assert.equal(packet.commitSha, merged);
  assert.deepEqual(packet.deliverables, ["src/own-delivery.ts"]);
  // Without that earlier cut nothing proves the merge is this task's: the cut freezes empty.
  const unproven = await derive(root, "Re-derived without a prior cut.", undefined, [], undefined, {
    kind: "commit",
    commitSha: git(root, "rev-parse", `${merged}^1`),
  });
  assert.equal(unproven.commitSha, null);
  assert.deepEqual(unproven.deliverables, []);
});

// The amendment variant of the same gate: the frozen cut belongs to THIS execution, not an
// earlier one. `ha task submit --amend` after the task's own PR merged re-derives at the merged
// tip with no --commit (review F1 on the first cut of this fix).
test("a same-execution amendment at its own merged tip keeps the manifest and its migration lane", async (t) => {
  const { root, base } = fixture(t),
    worker = path.join(root, ".worktrees/task-1");
  git(root, "worktree", "add", "-qb", "task-1", worker, base);
  put(worker, "packages/storage/src/store/own-migration.ts", "export const ownMigration = 1;\n");
  commit(worker);
  const branchTip = git(worker, "rev-parse", "HEAD"),
    frozenCut = await derive(root, "Migrated the stored shape.", undefined, [], undefined, {
      kind: "commit",
      commitSha: base,
    });
  assert.equal(frozenCut.commitSha, branchTip);
  git(root, "merge", "--no-ff", "-qm", "Merge pull request #1 from x/task-1", "task-1");
  const merged = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", merged);
  git(root, "worktree", "remove", worker);
  git(root, "branch", "-D", "task-1");
  git(root, "worktree", "add", "-qb", "task-1", worker, merged);
  const packet = await derive(
    root,
    "Amended after the merge.",
    undefined,
    [],
    undefined,
    { kind: "commit", commitSha: base },
    undefined,
    "repository-diff",
    undefined,
    frozenCut,
  );
  assert.equal(packet.commitSha, merged);
  assert.deepEqual(packet.deliverables, ["packages/storage/src/store/own-migration.ts"]);
  const lanes = reviewPathRules(["data-migration packages/storage/src/store/"]);
  assert.equal(reviewPathHits(packet, lanes).get("data-migration")?.length, 1);
});

// The PR body generator rejects a closeout without the two Chinese sections; submit is the writing
// boundary that must reject the same cut, through the same kernel judgment, while the worker can
// still see and fix the file. A recognized public hosting origin is what makes the delivery a PR.
test("a public PR delivery refuses a closeout without Chinese summary and verification", async (t) => {
  const { root } = fixture(t),
    origin = mkdtempSync(path.join(tmpdir(), "ha-closeout-public-origin-"));
  t.after(() => rmSync(origin, { recursive: true, force: true }));
  git(origin, "init", "--bare", "-q", "--initial-branch=main");
  git(root, "remote", "add", "origin", "https://github.com/acme/project.git");
  git(root, "config", `url.file://${origin}.insteadOf`, "https://github.com/acme/project.git");
  put(root, "harness/harness.yaml", "settings:\n  hosting:\n    provider: github\n    host: github.com\n");
  git(root, "push", "-q", "--set-upstream", "origin", "main");
  put(root, "src/live.ts", "export const liveValue = 7;\n");
  const sha = commit(root),
    englishOnly = "# Closeout\n\n## Summary\n\nEnglish only.\n\n## Verification\n\n- exit 0.\n";
  await assert.rejects(
    async () =>
      await derive(
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
        undefined,
        undefined,
        undefined,
        englishOnly,
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { readonly code?: string }).code, "invalid_submission");
      assert.match(error.message, /harness\/tasks\/task-1\/closeout\.md/u, "the rejection names the closeout path");
      assert.match(error.message, /## 摘要/u, "the rejection names the missing Chinese summary");
      assert.match(error.message, /## 验证/u, "the rejection names the missing Chinese verification");
      return true;
    },
  );
});

test("a public PR delivery accepts a closeout carrying both Chinese sections", async (t) => {
  const { root } = fixture(t),
    // `git remote get-url` still names a GitHub host, while the transport rewrite keeps the fetch
    // inside the fixture instead of reaching the network.
    origin = mkdtempSync(path.join(tmpdir(), "ha-closeout-public-origin-"));
  t.after(() => rmSync(origin, { recursive: true, force: true }));
  git(origin, "init", "--bare", "-q", "--initial-branch=main");
  git(root, "remote", "add", "origin", "https://github.com/acme/project.git");
  git(root, "config", `url.file://${origin}.insteadOf`, "https://github.com/acme/project.git");
  put(root, "harness/harness.yaml", "settings:\n  hosting:\n    provider: github\n    host: github.com\n");
  git(root, "push", "-q", "--set-upstream", "origin", "main");
  git(root, "fetch", "--quiet", "origin", "refs/heads/main:refs/remotes/origin/main");
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  put(root, "src/live.ts", "export const liveValue = 8;\n");
  const sha = commit(root),
    bilingual =
      "# Closeout\n\n## Summary\n\nDelivered English.\n\n## Verification\n\n- exit 0.\n\n" +
      "## 摘要\n\n交付完成。\n\n## 验证\n\n- 退出码 0。\n",
    packet = await derive(
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
      undefined,
      undefined,
      undefined,
      bilingual,
    );
  assert.equal(packet.commitSha, sha);
  assert.equal(packet.completionClaim, "Delivered English.");
});
