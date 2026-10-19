// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  gateResults,
  INITIAL_SETTINGS_V1,
  effectiveCloseoutGates,
  reduceTaskEvent,
  taskCompletionNext,
  type CloseoutSettingsV1,
  type TaskLifecycleSnapshot,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { repoCellTaskQueryJudgmentsFor } from "../src/repo-cell.ts";
import { readCompletionContext, readCompletionDeliveryStatus } from "../src/task-completion-read.ts";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function codeDelivery(
  snapshot: TaskLifecycleSnapshot,
  commitSha: string | null,
  mergeSha?: string,
): TaskLifecycleSnapshot {
  return {
    ...snapshot,
    executions: snapshot.executions.map((execution) => ({
      ...execution,
      submission: execution.submission ? { ...execution.submission, commitSha } : null,
      ...(mergeSha
        ? {
            annotations: [
              ...(execution.annotations ?? []),
              {
                kind: "correction" as const,
                note: `merge_commit_sha:${mergeSha}`,
                actor: execution.actor,
                annotatedAt: "2026-10-18T00:00:00.000Z",
              },
            ],
          }
        : {}),
    })),
  };
}

const strictSubmitted: TaskLifecycleSnapshot = lifecycleFixture().events.slice(0, 3).reduce(reduceTaskEvent, {
  revision: 0,
  task: null,
  executions: [],
  reviews: [],
  consents: [],
  codeDocWitnesses: [],
  gateWitnesses: [],
  edgesTaken: [],
  lease: null,
});

function frozenCut(closeout: CloseoutSettingsV1, overrides = {}) {
  return {
    ...strictSubmitted,
    executions: strictSubmitted.executions.map((execution) => ({
      ...execution,
      submission: {
        ...execution.submission!,
        completionContract: {
          ...execution.submission!.completionContract,
          closeoutGates: effectiveCloseoutGates(closeout, [], overrides),
        },
      },
    })),
  } as TaskLifecycleSnapshot;
}
const submitted = frozenCut({ profile: "standard" });

/** Settings-facet-aware read projection stub: one submitted unreviewed cut and a valid closeout. */
function projection(
  closeout: CloseoutSettingsV1 | null,
  factRows = 1,
  childCount = 0,
  requireMerged = false,
  outputShape: string | null = "repository-diff",
): TaskProjectionQueries {
  return {
    read: () => ({
      snapshot: submitted,
      packagePath: "harness/tasks/task-1",
      status: "ready",
      watermark: 2,
      sourceRevision: 2,
    }),
    readDocument: (target: string) => ({
      watermark: 2,
      sourceRevision: 2,
      document: {
        path: target,
        blobSha256: "0".repeat(64),
        workspaceRevision: 2,
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
          : "## Summary\nDelivered.\n## Verification\nVerified.\n## Residual Risk\nNone.\n" +
            "## Same Mechanism Elsewhere\nChecked.\n",
      },
    }),
    readRelationQuery: () => ({
      rows: factRows ? [{ targetRef: "fact/f-read-side", state: "active" }] : [],
      status: "ready",
    }),
    readPresetSnapshot: () => ({
      snapshot: outputShape ? { profile: { outputShape } } : null,
      status: "ready",
    }),
    readTaskChildCounts: (ids: readonly string[]) => (childCount ? { [ids[0]!]: childCount } : {}),
    getEntity: (kind: string, id: string) =>
      kind === "settings" && id === "repository" && closeout
        ? { value: { closeout, delivery: { ...INITIAL_SETTINGS_V1.delivery, requireMerged } } }
        : null,
  } as unknown as TaskProjectionQueries;
}

test("standard profile read side reports no closed-gate completion blockers", () => {
  const context = readCompletionContext(projection({ profile: "standard" }), "task-1", submitted, "ready");
  assert.deepEqual(context.closeoutGates, {
    review: false,
    consent: false,
    fact: true,
    factDisposition: false,
    codeDoc: false,
  });
  assert.equal(taskCompletionNext(submitted, context).blocker, null);
});

test("strict profile read side keeps demanding review and consent", () => {
  const context = readCompletionContext(projection({ profile: "strict" }), "task-1", strictSubmitted, "ready");
  assert.deepEqual(context.closeoutGates, {
    review: true,
    consent: true,
    fact: true,
    factDisposition: true,
    codeDoc: true,
  });
  // The strict cut sits in `submitted`: the blocker names the owner's triage, not a reviewer.
  assert.equal(taskCompletionNext(submitted, context).blocker?.code, "not_in_review");
});

test("a repository without a settings entity reads the standard default gates", () => {
  const context = readCompletionContext(projection(null), "task-1", submitted, "ready");
  assert.equal(context.delivery?.required, true);
  assert.equal(taskCompletionNext(submitted, context).blocker?.code, "delivery_missing");
});

test("a task-bound fact lift completes factless; the repository default still demands one", () => {
  const lightweight = {
      ...frozenCut({ profile: "standard" }, { review: false, consent: false, fact: false }),
      task: { ...submitted.task!, closeoutOverrides: { review: false, consent: false, fact: false } },
    },
    context = readCompletionContext(projection({ profile: "standard" }, 0), "task-1", lightweight, "ready");
  assert.deepEqual(context.closeoutGates, {
    review: false,
    consent: false,
    fact: false,
    factDisposition: false,
    codeDoc: false,
  });
  assert.equal(context.producesFactCount, 0);
  assert.equal(taskCompletionNext(lightweight, context).blocker, null);
  // Negative control: without the task-bound lift the same factless cut is blocked.
  const baseline = readCompletionContext(projection({ profile: "standard" }, 0), "task-1", submitted, "ready");
  assert.equal(taskCompletionNext(submitted, baseline).blocker?.code, "fact_missing");
});

test("the task query closeout judgment follows the effective gate set", () => {
  const availability = { consents: "known", codeDocWitnesses: "known", gateWitnesses: "known" } as const,
    standard = repoCellTaskQueryJudgmentsFor(projection({ profile: "standard" })).closeout(submitted, availability),
    strict = repoCellTaskQueryJudgmentsFor(projection({ profile: "strict" })).closeout(strictSubmitted, availability);
  assert.equal(standard.readiness, "ready");
  assert.equal(strict.readiness, "incomplete");
  assert.equal(strict.blocker, "review");
});

test("a planned top-level task with children is a derived work root and completion names work show", () => {
  const planned = lifecycleFixture()
    .events.slice(0, 1)
    .reduce(reduceTaskEvent, { ...submitted, revision: 0, task: null });
  assert.equal(planned.task?.metadata?.parentTaskId ?? null, null);
  const derived = readCompletionContext(projection({ profile: "standard" }, 1, 2), "task-1", planned, "ready");
  assert.equal(derived.childTaskCount, 2);
  assert.equal(taskCompletionNext(planned, derived).blocker?.next.action, "ha work show task-1");
  // Negative control: the same planned task without children is an ordinary task and still starts.
  const leaf = readCompletionContext(projection({ profile: "standard" }), "task-1", planned, "ready");
  assert.equal(taskCompletionNext(planned, leaf).blocker?.next.action, "ha task start task-1");
});

// dec_4190D5EA63D9DD208CE946F133: mutable settings do not recompute an accepted cut.
test("changing repository closeout settings leaves the submitted contract frozen", () => {
  const context = readCompletionContext(projection({ profile: "strict" }), "task-1", submitted, "ready");
  assert.deepEqual(context.closeoutGates, submitted.executions[0]!.submission!.completionContract.closeoutGates);
  assert.equal(taskCompletionNext(submitted, context).blocker, null);
});

test("delivery merge reads distinguish merged, unmerged, and unavailable Git evidence", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-delivery-completion-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  writeFileSync(path.join(root, "delivery.txt"), "base\n");
  git(root, "add", "delivery.txt");
  git(root, "commit", "-qm", "base");
  const base = git(root, "rev-parse", "HEAD");
  writeFileSync(path.join(root, "delivery.txt"), "merged\n");
  git(root, "commit", "-qam", "merge candidate");
  const merge = git(root, "rev-parse", "HEAD"),
    shape = (outputShape: string) => ({
      getEntity: () => ({
        value: { delivery: { ...INITIAL_SETTINGS_V1.delivery, targetBranch: "release", platform: "gitlab" } },
      }),
      readPresetSnapshot: () => ({ status: "ready", snapshot: { profile: { outputShape } } }),
    }),
    projection = shape("repository-diff") as unknown as TaskProjectionQueries,
    read = (snapshot: TaskLifecycleSnapshot, shapeProjection = projection) =>
      readCompletionDeliveryStatus(shapeProjection, snapshot, root),
    code = codeDelivery(strictSubmitted, merge, merge);

  git(root, "update-ref", "refs/remotes/origin/release", merge);
  assert.deepEqual(read(code), { required: true, merged: true, targetBranch: "release", platform: "gitlab" });

  git(root, "update-ref", "refs/remotes/origin/release", base);
  assert.equal(read(code).merged, false, "a known target that does not contain the merge commit is unmerged");

  git(root, "update-ref", "-d", "refs/remotes/origin/release");
  assert.equal(read(code).merged, null, "a missing configured target ref is unknown");
  assert.equal(read(codeDelivery(strictSubmitted, null, merge)).required, false, "artifact-only delivery skips merge");
  assert.equal(read(codeDelivery(strictSubmitted, merge)).merged, null, "a missing merge annotation is unknown");
  assert.equal(
    read(codeDelivery(strictSubmitted, merge, "f".repeat(40))).merged,
    null,
    "an unavailable merge object is unknown",
  );
  assert.equal(
    read(codeDelivery(strictSubmitted, merge), shape("task-package-artifact") as unknown as TaskProjectionQueries)
      .required,
    false,
    "a task-package-artifact delivery never enters the merge check, recorded commit or not",
  );
});

/** A review/consent/fact-lifted submitted cut whose submission carries a recorded delivery commit:
 * the shape a stale artifact-only submit left behind (submit once recorded the then main HEAD). */
function liftedCutWithCommit(sha: string): TaskLifecycleSnapshot {
  const lifted = frozenCut({ profile: "standard" }, { review: false, consent: false, fact: false });
  return codeDelivery(
    {
      ...lifted,
      task: { ...lifted.task!, closeoutOverrides: { review: false, consent: false, fact: false } },
    },
    sha,
  );
}

test("a task-package-artifact cut with a recorded commit completes without a merged delivery", () => {
  const cut = liftedCutWithCommit("b".repeat(40)),
    context = readCompletionContext(
      projection({ profile: "standard" }, 1, 0, true, "task-package-artifact"),
      "task-1",
      cut,
      "ready",
    );
  assert.equal(context.delivery?.required, false, "the merge check never applies to an artifact task");
  assert.equal(taskCompletionNext(cut, context).blocker, null);
});

test("a repository-diff cut with a recorded commit still requires its merged delivery", () => {
  const cut = liftedCutWithCommit("b".repeat(40)),
    context = readCompletionContext(
      projection({ profile: "standard" }, 1, 0, true, "repository-diff"),
      "task-1",
      cut,
      "ready",
    );
  assert.equal(context.delivery?.required, true);
  assert.equal(taskCompletionNext(cut, context).blocker?.code, "delivery_missing");
});

test("an unreadable output shape keeps the merged-delivery requirement", () => {
  const cut = liftedCutWithCommit("b".repeat(40)),
    context = readCompletionContext(projection({ profile: "standard" }, 1, 0, true, null), "task-1", cut, "ready");
  assert.equal(context.delivery?.required, true, "a degraded preset snapshot must not pass an unmerged delivery");
  assert.equal(taskCompletionNext(cut, context).blocker?.code, "delivery_missing");
});

test("merge evidence retires only the CI gate and does not lift review or consent", () => {
  const ci = {
      gateId: "ci",
      appliesTo: "code" as const,
      witness: {
        kind: "github-actions" as const,
        predicateType: "ci/v1",
        resultSchema: { type: "object" },
        adapterId: "github-actions" as const,
        adapterOptions: {
          workflows: ["checks"],
          branch: "main",
          event: "push",
          coverage: "exact" as const,
          selection: "newest" as const,
        },
      },
    },
    quality = {
      gateId: "quality",
      appliesTo: "code" as const,
      witness: {
        kind: "manual" as const,
        predicateType: "human/v1",
        resultSchema: { type: "object" },
        adapterId: "manual-attest",
        adapterOptions: {},
      },
    },
    snapshot = lifecycleFixture({ gates: [ci, quality], complete: false })
      .events.slice(0, 3)
      .reduce(reduceTaskEvent, {
        revision: 0,
        task: null,
        executions: [],
        reviews: [],
        consents: [],
        codeDocWitnesses: [],
        gateWitnesses: [],
        edgesTaken: [],
        lease: null,
      }),
    execution = snapshot.executions[0]!,
    delivery = { required: true, merged: true, targetBranch: "main", platform: "github" } as const,
    context = {
      closeout: "ready" as const,
      closeoutPath: "closeout.md",
      closeoutGates: { review: true, consent: true, fact: true, factDisposition: true, codeDoc: true },
      eligibleDirtyPaths: [],
      producesFactCount: 1,
      projectionStatus: "ready" as const,
      delivery,
    },
    results = gateResults(
      snapshot,
      undefined,
      execution.executionId,
      execution.submission,
      execution.iteration,
      delivery,
    );

  assert.equal(results.find(({ gateId }) => gateId === "ci")?.status, "passed");
  assert.equal(results.find(({ gateId }) => gateId === "quality")?.status, "missing");
  assert.equal(taskCompletionNext(strictSubmitted, { ...context, delivery }).blocker?.code, "not_in_review");

  const approvedWithoutConsent = lifecycleFixture().events.slice(0, 5).reduce(reduceTaskEvent, {
    revision: 0,
    task: null,
    executions: [],
    reviews: [],
    consents: [],
    codeDocWitnesses: [],
    gateWitnesses: [],
    edgesTaken: [],
    lease: null,
  });
  assert.equal(taskCompletionNext(approvedWithoutConsent, { ...context, delivery }).blocker?.code, "consent_missing");
});
