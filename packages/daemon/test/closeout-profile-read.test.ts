// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  reduceTaskEvent,
  taskCompletionNext,
  type CloseoutSettingsV1,
  type TaskLifecycleSnapshot,
  type TaskProjectionQueries,
} from "../../kernel/src/index.ts";
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

/** Settings-facet-aware read projection stub: one submitted unreviewed in_review cut and a valid closeout. */
function projection(closeout: CloseoutSettingsV1 | null): TaskProjectionQueries {
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
          ? JSON.stringify({ documents: [{ slot: "task.closeout", path: "closeout.md" }] })
          : "## Summary\nDelivered.\n## Verification\nVerified.\n## Residual Risk\nNone.\n" +
            "## Same Mechanism Elsewhere\nChecked.\n",
      },
    }),
    readRelationQuery: () => ({ rows: [{ targetRef: "fact/f-read-side", state: "active" }], status: "ready" }),
    getEntity: (kind: string, id: string) =>
      kind === "settings" && id === "repository" && closeout ? { value: { closeout } } : null,
  } as unknown as TaskProjectionQueries;
}

test("standard profile read side reports no closed-gate completion blockers", () => {
  const context = readCompletionContext(projection({ profile: "standard" }), "task-1", submitted, "ready");
  assert.deepEqual(context.closeoutGates, { review: false, consent: false, factDisposition: false, codeDoc: false });
  assert.equal(taskCompletionNext(submitted, context).blocker, null);
});

test("strict profile read side keeps demanding review and consent", () => {
  const context = readCompletionContext(projection({ profile: "strict" }), "task-1", submitted, "ready");
  assert.deepEqual(context.closeoutGates, { review: true, consent: true, factDisposition: true, codeDoc: true });
  assert.equal(taskCompletionNext(submitted, context).blocker?.code, "review_missing");
});

test("a repository without a settings entity reads the standard default gates", () => {
  const context = readCompletionContext(projection(null), "task-1", submitted, "ready");
  assert.equal(taskCompletionNext(submitted, context).blocker, null);
});

test("the task query closeout judgment follows the effective gate set", () => {
  const availability = { consents: "known", codeDocWitnesses: "known", gateWitnesses: "known" } as const,
    standard = repoCellTaskQueryJudgmentsFor(projection({ profile: "standard" })).closeout(submitted, availability),
    strict = repoCellTaskQueryJudgmentsFor(projection({ profile: "strict" })).closeout(submitted, availability);
  assert.equal(standard.readiness, "ready");
  assert.equal(strict.readiness, "incomplete");
  assert.equal(strict.blocker, "review");
});
