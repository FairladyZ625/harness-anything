// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  reduceTaskEvent,
  taskCompletionNext,
  type CloseoutSettingsV1,
  type TaskLifecycleSnapshot,
  type TaskProjectionQueries,
} from "@harness-anything/kernel";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { repoCellTaskQueryJudgmentsFor } from "../src/repo-cell.ts";
import { readCompletionContext } from "../src/task-completion-read.ts";

const submitted: TaskLifecycleSnapshot = lifecycleFixture().events.slice(0, 3).reduce(reduceTaskEvent, {
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

/** Settings-facet-aware read projection stub: one submitted unreviewed cut and a valid closeout. */
function projection(closeout: CloseoutSettingsV1 | null, factRows = 1): TaskProjectionQueries {
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
    getEntity: (kind: string, id: string) =>
      kind === "settings" && id === "repository" && closeout ? { value: { closeout } } : null,
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
  const context = readCompletionContext(projection({ profile: "strict" }), "task-1", submitted, "ready");
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
  assert.equal(taskCompletionNext(submitted, context).blocker, null);
});

test("a task-bound fact lift completes factless; the repository default still demands one", () => {
  const lightweight = {
      ...submitted,
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
    strict = repoCellTaskQueryJudgmentsFor(projection({ profile: "strict" })).closeout(submitted, availability);
  assert.equal(standard.readiness, "ready");
  assert.equal(strict.readiness, "incomplete");
  assert.equal(strict.blocker, "review");
});
