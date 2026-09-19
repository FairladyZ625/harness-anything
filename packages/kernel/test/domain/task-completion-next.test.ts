// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { reduceTaskEvent, taskCompletionNext } from "../../src/index.ts";
import { emptyTaskLifecycleSnapshot } from "../../src/domain/task-lifecycle.contract.ts";
import { lifecycleFixture } from "../store/task-lifecycle-fixture.ts";

const fixture = lifecycleFixture();
const at = (count: number) => fixture.events.slice(0, count).reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot());
const context = {
  closeout: "ready" as const,
  closeoutPath: "tasks/task-1/closeout.md",
  eligibleDirtyPaths: [],
  producesFactCount: 1,
};

test("completion next is one pure judgment across lifecycle and unavailable-input fixtures", () => {
  const active = at(2),
    submitted = at(3),
    ready = at(5);
  const cases = [
    ["planned", at(1), context, "not_in_review", "ha task start task-1"],
    ["active own lease", active, context, "not_in_review", "submit execution execution-1"],
    [
      "active other lease",
      {
        ...active,
        lease: {
          ...active.lease!,
          actor: {
            principal: { personId: "other-person" },
            executor: { kind: "agent" as const, id: "other-agent" },
          },
        },
      },
      context,
      "not_in_review",
      "submit execution execution-1",
    ],
    [
      "returned review without a current execution",
      { ...active, task: { ...active.task!, iteration: active.task!.iteration + 1 } },
      context,
      "not_in_review",
      "ha task start task-1",
    ],
    ["submitted unreviewed", submitted, context, "review_missing", "ha task complete"],
    ["approved awaits consent", at(4), context, "consent_missing", "ha task complete task-1 --consent"],
    [
      "multiple approved reviews await consent",
      { ...at(4), reviews: [...at(4).reviews, { ...at(4).reviews[0]!, reviewId: "review-additional" }] },
      context,
      "consent_missing",
      "ha task complete task-1 --consent",
    ],
    ["done", at(6), context, null, null],
    [
      "projection unknown",
      ready,
      { ...context, projectionStatus: "pending" as const },
      "projection_unknown",
      "ha daemon projection rebuild",
    ],
    [
      "multiple executions",
      {
        ...submitted,
        executions: [submitted.executions[0]!, { ...submitted.executions[0]!, executionId: "execution-other" }],
      },
      context,
      "execution_ambiguous",
      "ha task show task-1",
    ],
    [
      "empty section",
      ready,
      {
        ...context,
        closeout: "placeholder" as const,
        closeoutMissingSections: [{ section: "Verification", reason: "empty" as const }],
      },
      "closeout_placeholder",
      "section Verification",
    ],
    [
      "bad artifact",
      ready,
      {
        ...context,
        invalidDocument: {
          path: "tasks/task-1/artifacts/bad.md",
          reason: "candidate conflicts with canonical document",
        },
      },
      "document_invalid",
      "Repair harness/tasks/task-1/artifacts/bad.md",
    ],
    [
      "denied authority",
      ready,
      { ...context, authorization: "denied" as const },
      "actor_unauthorized",
      "ha task complete task-1",
    ],
    ["ready", ready, context, null, null],
  ] as const;
  for (const [label, snapshot, input, code, action] of cases) {
    const before = structuredClone({ snapshot, input, events: fixture.events });
    const result = taskCompletionNext(snapshot, input);
    assert.equal(result.blocker?.code ?? null, code, label);
    if (action !== null) assert.ok(result.next?.action.includes(action), label);
    else assert.equal(result.next, null, label);
    if (result.next) {
      assert.equal(result.next.readCut.revision, snapshot.revision, label);
      assert.deepEqual(Object.keys(result.next).sort(), ["action", "authority", "readCut", "reason"], label);
    }
    assert.deepEqual({ snapshot, input, events: fixture.events }, before, label);
  }
  assert.equal(taskCompletionNext(cases[2][1], context).next?.authority, "other-agent");
});

// The submission's frozen contract is the gate list; it must exist at submit time so review and
// consent digests pin the same cut.
const codeDocRequirement = {
    gateId: "code-doc-reconciliation",
    appliesTo: "code" as const,
    witness: { adapterId: "code-doc-reconciliation" as const, adapterOptions: {} },
  },
  ciRequirement = {
    gateId: "ci",
    appliesTo: "code" as const,
    witness: {
      adapterId: "github-actions" as const,
      adapterOptions: {
        workflows: ["rewrite-ci"],
        branch: "main",
        event: "push",
        coverage: "exact" as const,
        selection: "newest" as const,
      },
    },
  };
const gatedAt = (gates: readonly (typeof ciRequirement | typeof codeDocRequirement)[], count: number) =>
  lifecycleFixture({ gates, complete: false })
    .events.slice(0, count)
    .reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot());

test("missing delivery paths identify the Summary instead of a JSON closeout recipe", () => {
  const result = taskCompletionNext(gatedAt([codeDocRequirement], 5), context);
  assert.equal(result.blocker?.code, "code_doc_missing");
  assert.match(result.next!.action, /Identify the delivery paths.*Summary/);
  assert.doesNotMatch(result.next!.action, /packet.json|task closeout/);
});

test("missing facts guide an observable change while a recorded fact clears the blocker", () => {
  const snapshot = at(5),
    missing = taskCompletionNext(snapshot, { ...context, producesFactCount: 0 });
  assert.equal(missing.blocker?.code, "fact_missing");
  assert.match(missing.next!.action, /ha fact record --task task-1/);
  assert.match(missing.next!.action, /--statement "<what changed and why it matters>"/);
  assert.match(missing.next!.action, /--source "<evidence path or observation>" --confidence high/);
  assert.match(missing.next!.reason, /observable change.*evidence/);
  assert.match(missing.next!.reason, /execution recaps and test counts in closeout Verification/);
  assert.equal(taskCompletionNext(snapshot, context).blocker, null);
});

test("a profile that lifted the fact gate completes without facts; the gate stays on by default", () => {
  const snapshot = at(5),
    lightweight = {
      ...context,
      producesFactCount: 0,
      closeoutGates: { review: false, consent: false, fact: false, factDisposition: false, codeDoc: false },
    };
  assert.equal(taskCompletionNext(snapshot, lightweight).blocker, null);
  // Repository ceremony profiles cannot relax it: only the task-bound declaration did.
  const repositoryRelaxed = {
    ...lightweight,
    closeoutGates: { review: false, consent: false, fact: true, factDisposition: false, codeDoc: false },
  };
  assert.equal(taskCompletionNext(snapshot, repositoryRelaxed).blocker?.code, "fact_missing");
});

test("missing CI witness precedes independent review and requests canonical observation", () => {
  const result = taskCompletionNext(gatedAt([ciRequirement], 3), context);
  assert.equal(result.blocker?.code, "ci_missing");
  assert.equal(result.next?.action, "ha ci observe pull");
});
