// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  reduceTaskEvent,
  rematerializeTaskDocuments,
  taskCompletionNext,
  type TaskMetadataV1,
} from "../../src/index.ts";
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
    forwarded = at(4),
    ready = at(6);
  const cases = [
    ["planned", at(1), context, "not_in_review", "ha task start task-1"],
    ["active own lease", active, context, "not_in_review", "ha task submit task-1"],
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
      "ha task submit task-1",
    ],
    [
      "planned work root derives its status instead of starting an execution",
      { ...at(1), task: { ...at(1).task!, taskClass: "work" as const } },
      context,
      "not_in_review",
      "ha work show task-1",
    ],
    [
      "planned top-level task with children is a derived work root",
      at(1),
      { ...context, childTaskCount: 2 },
      "not_in_review",
      "ha work show task-1",
    ],
    [
      "planned child task with children is not a work root",
      { ...at(1), task: { ...at(1).task!, metadata: { parentTaskId: "task-0" } as TaskMetadataV1 } },
      { ...context, childTaskCount: 2 },
      "not_in_review",
      "ha task start task-1",
    ],
    // A settled worker releases its lease and leaves the execution active; start reconnects to that execution
    // (dec_E5103E62F80728C06AFCFCD133), so completion resumes rather than abandoning the round.
    ["active released lease", { ...active, lease: null }, context, "not_in_review", "ha task start task-1"],
    [
      "returned review without a current execution",
      { ...active, task: { ...active.task!, iteration: active.task!.iteration + 1 } },
      context,
      "not_in_review",
      "ha task start task-1",
    ],
    [
      "submitted awaits the owner's triage",
      submitted,
      context,
      "not_in_review",
      "ha task adjudicate task-1 --forward --note-file <path>",
    ],
    ["forwarded unreviewed", forwarded, context, "review_missing", "ha task dispatch-review task-1"],
    ["approved awaits the owner's verdict", at(5), context, "consent_missing", "ha task review-consent task-1"],
    [
      "multiple approved reviews await the owner's verdict",
      { ...at(5), reviews: [...at(5).reviews, { ...at(5).reviews[0]!, reviewId: "review-additional" }] },
      context,
      "consent_missing",
      "ha task review-consent task-1",
    ],
    ["done", at(7), context, null, null],
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
    witness: { kind: "internal" as const, adapterId: "code-doc-reconciliation" as const, adapterOptions: {} },
  },
  ciRequirement = {
    gateId: "ci",
    appliesTo: "code" as const,
    witness: {
      kind: "github-actions" as const,
      predicateType: "ci/v1",
      resultSchema: { type: "object" },
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

test("an empty delivery cut skips code/doc reconciliation and still requires CI", () => {
  const result = taskCompletionNext(gatedAt([codeDocRequirement, ciRequirement], 6), context);
  assert.equal(result.blocker?.code, "ci_missing");
  assert.doesNotMatch(result.next!.action, /Identify the delivery paths|code-doc reconcile/);
});

test("a nonempty delivery cut still requires a code/doc witness", () => {
  const snapshot = gatedAt([codeDocRequirement], 6);
  const result = taskCompletionNext(
    {
      ...snapshot,
      executions: snapshot.executions.map((execution) => ({
        ...execution,
        submission: execution.submission ? { ...execution.submission, deliverables: ["src/delivery.ts"] } : null,
      })),
    },
    context,
  );
  assert.equal(result.blocker?.code, "code_doc_missing");
  assert.equal(result.next!.action, "ha task code-doc reconcile task-1 --path 'src/delivery.ts'");
});

test("missing facts guide an observable change while a recorded fact clears the blocker", () => {
  const snapshot = at(6),
    missing = taskCompletionNext(snapshot, { ...context, producesFactCount: 0 });
  assert.equal(missing.blocker?.code, "fact_missing");
  assert.match(missing.next!.action, /ha fact record --task task-1/);
  assert.match(missing.next!.action, /--statement "<what changed and why it matters>"/);
  assert.match(missing.next!.action, /--source "<evidence path or observation>" --confidence high/);
  assert.match(missing.next!.reason, /observable change.*evidence/);
  assert.match(missing.next!.reason, /execution recaps and test counts in closeout Verification/);
  assert.equal(taskCompletionNext(snapshot, context).blocker, null);
});

test("a contract that declares no closeout starts completion with its migration", () => {
  const undeclared = { ...context, closeout: "missing" as const, closeoutPath: "" };
  for (const snapshot of [at(1), at(2), at(6)]) {
    const result = taskCompletionNext(snapshot, undeclared);
    assert.equal(result.blocker?.code, "document_invalid");
    assert.equal(result.next!.action, "ha task contract migrate --apply --task task-1");
  }
  const done = at(fixture.events.length);
  assert.equal(done.task?.status, "done");
  assert.equal(taskCompletionNext(done, undeclared).blocker, null);
});

test("a profile that lifted the fact gate completes without facts; the gate stays on by default", () => {
  const snapshot = at(6),
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
  const result = taskCompletionNext(gatedAt([ciRequirement], 6), context);
  assert.equal(result.blocker?.code, "ci_missing");
  assert.equal(
    result.next?.action,
    "Wait for the center CI Schedule to collect the workflow witness; inspect ha schedule show builtin-ci-observe.",
  );
});

// Q1-R1-003: an adverse verdict on the current cut is the owner's to adjudicate, not a missing review.
test("a recorded changes_requested review guides the owner's return instead of another review dispatch", () => {
  const reviewed = at(5),
    changesRequested = {
      ...reviewed,
      reviews: [{ ...reviewed.reviews[0]!, reviewId: "review-changes", verdict: "changes_requested" as const }],
    },
    result = taskCompletionNext(changesRequested, context);
  assert.equal(result.blocker?.code, "review_missing");
  assert.equal(result.next?.action, "ha task adjudicate task-1 --return --review-id review-changes --note-file <path>");
  assert.equal(result.next?.authority, "person-owner");
  assert.doesNotMatch(result.next!.reason, /no recorded review/u);
  assert.match(result.next!.reason, /rework/u);
  const index = rematerializeTaskDocuments({
    snapshot: changesRequested,
    packagePath: "tasks/task-1",
    paths: ["tasks/task-1/INDEX.md"],
    currentDocuments: [],
  })[0]!.body;
  assert.match(index, /ha task adjudicate task-1 --return --review-id review-changes --note-file <path>/u);
  assert.doesNotMatch(index, /dispatch-review/u);
  // Without any recorded review the dispatch guidance stands.
  assert.equal(taskCompletionNext(at(4), context).next?.action, "ha task dispatch-review task-1");
});

// Q1-R1-004: review-consent selects a sole approved candidate itself; only a choice needs its id.
test("a changes request on the current cut comes before missing CI evidence", () => {
  const reviewed = gatedAt([ciRequirement], 5),
    changesRequested = {
      ...reviewed,
      reviews: [{ ...reviewed.reviews[0]!, reviewId: "review-changes", verdict: "changes_requested" as const }],
    },
    result = taskCompletionNext(changesRequested, context);
  assert.equal(result.blocker?.code, "review_missing");
  assert.equal(result.next?.action, "ha task adjudicate task-1 --return --review-id review-changes --note-file <path>");
  // Without the changes request the missing CI witness still leads.
  assert.equal(taskCompletionNext(reviewed, context).blocker?.code, "ci_missing");
});

test("consent guidance relies on automatic selection for one candidate and names each of several", () => {
  const single = at(5),
    multiple = { ...single, reviews: [...single.reviews, { ...single.reviews[0]!, reviewId: "review-additional" }] },
    index = (snapshot: typeof single) =>
      rematerializeTaskDocuments({
        snapshot,
        packagePath: "tasks/task-1",
        paths: ["tasks/task-1/INDEX.md"],
        currentDocuments: [],
      })[0]!.body;
  assert.equal(taskCompletionNext(single, context).next?.action, "ha task review-consent task-1");
  assert.match(index(single), /`ha task review-consent task-1`/u);
  const several = taskCompletionNext(multiple, context).next!.action;
  assert.doesNotMatch(several, /<review-id>/u);
  assert.equal(
    several,
    "ha task review-consent task-1 --review-id review-execution or ha task review-consent task-1 --review-id review-additional",
  );
  assert.match(index(multiple), /--review-id review-execution or .*--review-id review-additional`/u);
});

test("an undisposed changes request prevents an approved review from reaching consent", () => {
  const approved = at(5),
    conflicted = {
      ...approved,
      reviews: [
        ...approved.reviews,
        { ...approved.reviews[0]!, reviewId: "review-changes", verdict: "changes_requested" as const },
      ],
    },
    result = taskCompletionNext(conflicted, context);
  assert.equal(result.blocker?.code, "review_missing");
  assert.equal(result.next?.action, "ha task adjudicate task-1 --return --review-id review-changes --note-file <path>");
});

test("an executorless review without dispatch lineage names an executable independent-review step", () => {
  const forwarded = at(4),
    executorless = {
      ...forwarded,
      executions: forwarded.executions.map((execution) => ({
        ...execution,
        actor: { ...execution.actor, executor: null },
      })),
    },
    result = taskCompletionNext(executorless, { ...context, hasDispatchLineage: false });
  assert.equal(result.blocker?.code, "executor_missing");
  assert.equal(
    result.next?.action,
    "ha task review-execution task-1 --execution-id execution-1 --review-id <id> --from-file <review.json>",
  );
  assert.doesNotMatch(result.next!.action, /declare-executor/u);
});

test("a missing executor blocks only while an independent review is still owed", () => {
  const withoutExecutor = (snapshot: ReturnType<typeof at>) => ({
      ...snapshot,
      executions: snapshot.executions.map((execution) => ({
        ...execution,
        actor: { ...execution.actor, executor: null },
      })),
    }),
    reviewLifted = { review: false, consent: false, fact: true, factDisposition: false, codeDoc: false };
  // A recorded review already judged independence, so the chain moves on to the remaining gates.
  assert.notEqual(taskCompletionNext(withoutExecutor(at(6)), context).blocker?.code, "executor_missing");
  // With the review gate lifted no reviewer independence is judged at all.
  assert.notEqual(
    taskCompletionNext(withoutExecutor(at(4)), { ...context, closeoutGates: reviewLifted }).blocker?.code,
    "executor_missing",
  );
});

test("INDEX next uses the same completion judgment for strict and lightweight profiles", () => {
  const submitted = at(3),
    index = (
      snapshot: typeof submitted,
      completionContext: typeof context & {
        readonly closeoutGates: Readonly<
          Record<"review" | "consent" | "fact" | "factDisposition" | "codeDoc", boolean>
        >;
      },
    ) =>
      rematerializeTaskDocuments({
        snapshot,
        packagePath: "tasks/task-1",
        paths: ["tasks/task-1/INDEX.md"],
        currentDocuments: [],
        completionContext,
      })[0]!.body,
    strict = {
      ...context,
      closeoutGates: { review: true, consent: true, fact: true, factDisposition: true, codeDoc: true },
    },
    lightweight = {
      ...context,
      producesFactCount: 0,
      closeoutGates: { review: false, consent: false, fact: false, factDisposition: false, codeDoc: false },
    };
  assert.match(index(submitted, strict), /ha task adjudicate task-1 --forward --note-file <path>/u);
  assert.match(index(submitted, lightweight), /ha task complete task-1/u);
});
