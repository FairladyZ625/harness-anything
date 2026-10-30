// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  completionBlockers,
  reduceTaskEvent,
  rematerializeTaskDocuments,
  submissionDigest,
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
};

// A task whose work already happened outside Harness has no execution to submit: the blocker
// must hand over the settle chain instead of reading as a dead end (task_b6896bab owner-done).
test("a never-started task names the evidence-and-settle chain, a started one keeps the plain message", () => {
  const neverStarted = taskCompletionNext(at(1), context);
  assert.equal(neverStarted.blocker?.code, "not_in_review");
  assert.match(neverStarted.next!.reason, /No execution has started/u);
  assert.match(neverStarted.next!.reason, /ha task settle task-1/u);
  assert.match(neverStarted.next!.reason, /closeout\.md/u);
  // A round that returned to planned still has its executions: the plain submission message stands.
  const returned = { ...at(2), lease: null, task: { ...at(2).task!, status: "planned" as const } };
  assert.doesNotMatch(taskCompletionNext(returned, context).next!.reason, /settle/u);
});

test("completion next is one pure judgment across lifecycle and unavailable-input fixtures", () => {
  const active = at(2),
    submitted = at(3),
    ready = at(5);
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
      "submitted automatically awaits independent review",
      submitted,
      context,
      "review_pending",
      "ha task dispatch-review task-1",
    ],
    ["approved awaits the owner's verdict", at(4), context, "consent_missing", "ha task review-consent task-1"],
    [
      "multiple approved reviews await the owner's verdict",
      { ...at(4), reviews: [...at(4).reviews, { ...at(4).reviews[0]!, reviewId: "review-additional" }] },
      context,
      "consent_missing",
      "ha task review-consent task-1",
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
  manualRequirement = {
    gateId: "signoff",
    appliesTo: "code" as const,
    witness: {
      kind: "manual" as const,
      predicateType: "harness/attestation/v1",
      resultSchema: { type: "object" },
      adapterId: "manual-attest" as const,
      adapterOptions: {},
    },
  },
  retiredCiRequirement = {
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
const gatedAt = (
  gates: readonly (typeof retiredCiRequirement | typeof manualRequirement | typeof codeDocRequirement)[],
  count: number,
) =>
  lifecycleFixture({ gates, complete: false })
    .events.slice(0, count)
    .reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot());

test("a retired code/doc requirement never demands a witness, empty cut or not", () => {
  const snapshot = gatedAt([codeDocRequirement], 5),
    withDeliverables = (deliverables: readonly string[]) => ({
      ...snapshot,
      executions: snapshot.executions.map((execution) => ({
        ...execution,
        submission: execution.submission ? { ...execution.submission, deliverables } : null,
      })),
    });
  // Empty and non-empty cuts alike: the retired gate reads not_applicable, so it is never the
  // next step and never blocks completion.
  for (const deliverables of [[], ["src/delivery.ts"]]) {
    const all = completionBlockers(withDeliverables(deliverables), "execution-1", context);
    assert.equal(
      all.some(({ gate }) => gate === "code-doc-reconciliation"),
      false,
      `no blocker names the retired gate for ${deliverables.length} deliverables`,
    );
    assert.notEqual(taskCompletionNext(withDeliverables(deliverables), context).blocker?.code, "code_doc_missing");
  }
  // A live requirement in the same contract still surfaces as a missing witness, so the
  // assertion above is not passing because gates were ignored wholesale.
  assert.equal(taskCompletionNext(gatedAt([manualRequirement], 5), context).blocker?.code, "gate_witness_missing");
});

test("a frozen CI gate reads configured merge evidence instead of an observation", () => {
  const snapshot = gatedAt([retiredCiRequirement], 5),
    delivery = { required: true, targetBranch: "main", platform: "github" as const };
  const unmerged = taskCompletionNext(snapshot, { ...context, delivery: { ...delivery, merged: false } });
  assert.equal(unmerged.blocker?.code, "delivery_missing");
  assert.match(unmerged.next!.action, /node tools\/pr-merge\.mjs <PR-number-or-url>/u);
  assert.equal(taskCompletionNext(snapshot, { ...context, delivery: { ...delivery, merged: true } }).blocker, null);
});

test("delivery_missing prompts for pr-merge or annotate when merge annotation is missing", () => {
  const snapshot = gatedAt([retiredCiRequirement], 5),
    delivery = { required: true, targetBranch: "main", merged: null };
  const unmerged = taskCompletionNext(snapshot, { ...context, delivery });
  assert.equal(unmerged.blocker?.code, "delivery_missing");
  assert.match(unmerged.next!.action, /node tools\/pr-merge\.mjs <PR-number-or-url>/u);
  assert.match(unmerged.next!.action, /ha task annotate/u);
  assert.match(unmerged.next!.reason, /no merge commit annotation/u);
  assert.doesNotMatch(unmerged.next!.action, /fetch origin/u);
  assert.doesNotMatch(unmerged.next!.reason, /fetch origin/u);
});

test("delivery_missing prompts for fetch when merge annotation is present but ref is not visible locally", () => {
  const snapshot = gatedAt([retiredCiRequirement], 5),
    mergeSha = "f".repeat(40),
    delivery = { required: true, targetBranch: "main", merged: null, mergeSha };
  const unmerged = taskCompletionNext(snapshot, { ...context, delivery });
  assert.equal(unmerged.blocker?.code, "delivery_missing");
  assert.match(unmerged.next!.action, /git fetch origin main/u);
  assert.match(unmerged.next!.reason, /fetch origin\/main and retry/u);
  assert.doesNotMatch(unmerged.next!.action, /node tools\/pr-merge\.mjs/u);
});

test("delivery_missing points to the corrected merge annotation when its commit omits the cut", () => {
  const snapshot = gatedAt([retiredCiRequirement], 6),
    delivery = {
      required: true,
      merged: false,
      targetBranch: "main",
      mergeSha: "a".repeat(40),
      deliveryCommitSha: "b".repeat(40),
      deliveryIssue: "delivery-not-contained" as const,
    },
    unmerged = taskCompletionNext(snapshot, { ...context, delivery });
  assert.equal(unmerged.blocker?.code, "delivery_missing");
  assert.match(unmerged.next!.action, /merge_commit_sha:<sha>/u);
  assert.match(unmerged.next!.reason, /annotated merge commit .* does not contain the submitted delivery/u);
  assert.match(unmerged.next!.reason, /use the commit that actually contains that delivery/u);
});

test("delivery_missing points local-only repositories to the explicit Settings ref", () => {
  const snapshot = gatedAt([retiredCiRequirement], 6),
    mergeSha = "f".repeat(40),
    delivery = {
      required: true,
      targetBranch: "main",
      targetRef: "refs/heads/main",
      merged: null,
      mergeSha,
    };
  const unmerged = taskCompletionNext(snapshot, { ...context, delivery });
  assert.equal(unmerged.blocker?.code, "delivery_missing");
  assert.match(unmerged.next!.action, /configured target ref refs\/heads\/main/u);
  assert.match(unmerged.next!.reason, /configured delivery ref refs\/heads\/main is not visible/u);
  assert.doesNotMatch(unmerged.next!.action, /git fetch origin/u);
});

test("completion has no fact quota: a task with zero recorded facts still clears every blocker", () => {
  // dec_BB2BCE9F995CD3A126E2918734 CH4 removed the per-task fact gate; facts are on-demand.
  assert.equal(taskCompletionNext(at(5), context).blocker, null);
});

test("a contract that declares no closeout starts completion with its migration", () => {
  const undeclared = { ...context, closeout: "missing" as const, closeoutPath: "" };
  for (const snapshot of [at(1), at(2), at(5)]) {
    const result = taskCompletionNext(snapshot, undeclared);
    assert.equal(result.blocker?.code, "document_invalid");
    assert.equal(result.next!.action, "ha task contract migrate --apply --task task-1");
  }
  const done = at(fixture.events.length);
  assert.equal(done.task?.status, "done");
  assert.equal(taskCompletionNext(done, undeclared).blocker, null);
});

// An adverse verdict is an explicit review rejection, not a missing review.
test("a recorded changes_requested review guides the owner's disposition instead of another review dispatch", () => {
  const reviewed = at(4),
    changesRequested = {
      ...reviewed,
      reviews: [{ ...reviewed.reviews[0]!, reviewId: "review-changes", verdict: "changes_requested" as const }],
    },
    result = taskCompletionNext(changesRequested, context);
  assert.equal(result.blocker?.code, "review_rejected");
  // The owner may return the cut or explicitly dispose the adverse verdict alongside consent.
  assert.equal(
    result.next?.action,
    "ha task rework task-1 --reason <why the owner is returning this cut>; or ha task review-consent task-1 --execution-id execution-1 --review-id review-changes --dispose review-changes --rationale <why the adverse verdict is overruled>",
  );
  assert.equal(result.next?.authority, "person-owner");
  assert.doesNotMatch(result.next!.reason, /no recorded review/u);
  assert.match(result.next!.reason, /requested changes/u);
  const index = rematerializeTaskDocuments({
    snapshot: changesRequested,
    packagePath: "tasks/task-1",
    paths: ["tasks/task-1/INDEX.md"],
    currentDocuments: [],
  })[0]!.body;
  assert.match(
    index,
    /ha task review-consent task-1 --execution-id execution-1 --review-id review-changes --dispose review-changes/u,
  );
  assert.doesNotMatch(index, /dispatch-review/u);
  // Without any recorded review the dispatch guidance stands.
  assert.equal(taskCompletionNext(at(3), context).next?.action, "ha task dispatch-review task-1");
});

test("a dismissed review is not an effective review and guides a fresh dispatch", () => {
  const reviewed = at(4),
    dismissed = {
      ...reviewed,
      reviews: [{ ...reviewed.reviews[0]!, reviewId: "review-dismissed", verdict: "dismissed" as const }],
    },
    result = taskCompletionNext(dismissed, context);
  assert.equal(result.blocker?.code, "review_pending");
  assert.equal(result.next?.action, "ha task dispatch-review task-1");
  assert.match(result.next?.reason ?? "", /no recorded review/u);
});

test("completion readiness asks only for consent when an approved review has findings", () => {
  const reviewed = at(4),
    escalated = {
      ...reviewed,
      reviews: [
        {
          ...reviewed.reviews[0]!,
          findings: [
            {
              findingId: "F-escalated",
              blocking: false,
              text: "Automated triage could not classify this finding.",
              category: "correctness" as const,
            },
          ],
        },
      ],
    },
    result = taskCompletionNext(escalated, context);

  assert.equal(result.blocker?.code, "consent_missing");
  assert.equal(
    result.next!.action,
    "ha task review-consent task-1 --execution-id execution-1 --review-id review-execution",
  );
  assert.doesNotMatch(result.next!.action, /finding-id|finding-disposition/u);
});

test("completion readiness does not enumerate findings when consent is missing", () => {
  const reviewed = at(4),
    escalated = {
      ...reviewed,
      reviews: [
        {
          ...reviewed.reviews[0]!,
          findings: [
            {
              findingId: "F-first",
              blocking: false,
              text: "First unresolved finding.",
              category: "correctness" as const,
            },
            {
              findingId: "F-second",
              blocking: false,
              text: "Second unresolved finding.",
              category: "completeness" as const,
            },
          ],
        },
      ],
    },
    result = taskCompletionNext(escalated, context);

  assert.equal(result.blocker?.code, "consent_missing");
  assert.equal(
    result.next!.action,
    "ha task review-consent task-1 --execution-id execution-1 --review-id review-execution",
  );
  assert.doesNotMatch(result.next!.action, /finding-id|finding-disposition/u);
});

test("completion readiness does not require whole-review disposal for unclassified findings", () => {
  const reviewed = at(4),
    unclassified = {
      ...reviewed,
      reviews: [
        {
          ...reviewed.reviews[0]!,
          findings: [
            { findingId: "F-legacy-one", blocking: true, text: "First unclassified finding." },
            { findingId: "F-legacy-two", blocking: true, text: "Second unclassified finding." },
          ],
        },
      ],
    },
    result = taskCompletionNext(unclassified, context);

  assert.equal(result.blocker?.code, "consent_missing");
  assert.equal(
    result.next!.action,
    "ha task review-consent task-1 --execution-id execution-1 --review-id review-execution",
  );
  assert.doesNotMatch(result.next!.action, /dispose|finding-id/u);
});

test("a changes request on the current cut comes before missing merge evidence", () => {
  const reviewed = gatedAt([retiredCiRequirement], 6),
    changesRequested = {
      ...reviewed,
      reviews: [{ ...reviewed.reviews[0]!, reviewId: "review-changes", verdict: "changes_requested" as const }],
    },
    delivery = { required: true, merged: false, targetBranch: "main", platform: "github" as const },
    result = taskCompletionNext(changesRequested, { ...context, delivery });
  assert.equal(result.blocker?.code, "review_rejected");
  assert.equal(
    result.next?.action,
    "ha task rework task-1 --reason <why the owner is returning this cut>; or ha task review-consent task-1 --execution-id execution-1 --review-id review-changes --dispose review-changes --rationale <why the adverse verdict is overruled>",
  );
  // Without the changes request, the old frozen CI gate is interpreted through merge evidence.
  assert.equal(taskCompletionNext(reviewed, { ...context, delivery }).blocker?.code, "delivery_missing");
});

// Consent guidance names the execution and the review explicitly: a sole candidate is never
// selected implicitly, so an exploratory run of the printed command can never write a consent.
test("consent guidance names both ids for one candidate and for each of several", () => {
  const single = at(4),
    multiple = { ...single, reviews: [...single.reviews, { ...single.reviews[0]!, reviewId: "review-additional" }] },
    index = (snapshot: typeof single) =>
      rematerializeTaskDocuments({
        snapshot,
        packagePath: "tasks/task-1",
        paths: ["tasks/task-1/INDEX.md"],
        currentDocuments: [],
      })[0]!.body;
  assert.equal(
    taskCompletionNext(single, context).next?.action,
    "ha task review-consent task-1 --execution-id execution-1 --review-id review-execution",
  );
  assert.match(
    index(single),
    /`ha task review-consent task-1 --execution-id execution-1 --review-id review-execution`/u,
  );
  const several = taskCompletionNext(multiple, context).next!.action;
  assert.doesNotMatch(several, /<review-id>/u);
  assert.equal(
    several,
    "ha task review-consent task-1 --execution-id execution-1 --review-id review-execution or " +
      "ha task review-consent task-1 --execution-id execution-1 --review-id review-additional",
  );
  assert.match(index(multiple), /--review-id review-execution or .*--review-id review-additional`/u);
});

// The completion gate reads the same dispositions review-consent recorded: a changes_requested
// review the owner disposed at consent no longer blocks completion.
test("a consent-disposed changes_requested review no longer blocks completion", () => {
  const consented = at(5),
    late = { ...consented.reviews[0]!, reviewId: "review-late", verdict: "changes_requested" as const },
    execution = consented.executions[0]!,
    withLate = { ...consented, reviews: [...consented.reviews, late] },
    disposed = {
      ...withLate,
      reviewDispositions: [
        {
          schema: "review-disposition/v1",
          dispositionId: "disposition-consent-1",
          taskId: "task-1",
          executionId: "execution-1",
          iteration: consented.task!.iteration,
          submissionDigest: submissionDigest(execution.submission!),
          disposedReviewIds: ["review-late"],
          rationale: "owner accepts the approved assessment",
          actor: consented.consents[0]!.actor,
          source: consented.consents[0]!.source,
          disposedAt: consented.consents[0]!.consentedAt,
        },
      ],
    };
  assert.equal(taskCompletionNext(withLate, context).blocker?.code, "review_rejected");
  assert.equal(taskCompletionNext(disposed, context).blocker, null);
  const index = rematerializeTaskDocuments({
    snapshot: disposed,
    packagePath: "tasks/task-1",
    paths: ["tasks/task-1/INDEX.md"],
    currentDocuments: [],
  })[0]!.body;
  assert.match(index, /ha task complete task-1/u);
  assert.doesNotMatch(index, /adjudicate task-1 --return/u);
});

test("an undisposed changes request prevents an approved review from reaching consent", () => {
  const approved = at(4),
    conflicted = {
      ...approved,
      reviews: [
        ...approved.reviews,
        { ...approved.reviews[0]!, reviewId: "review-changes", verdict: "changes_requested" as const },
      ],
    },
    result = taskCompletionNext(conflicted, context);
  assert.equal(result.blocker?.code, "review_rejected");
  // An approved review does exist on this cut, so the consent command names it and disposes the
  // adverse verdict beside it.
  assert.equal(
    result.next?.action,
    "ha task rework task-1 --reason <why the owner is returning this cut>; or ha task review-consent task-1 --execution-id execution-1 --review-id review-execution --dispose review-changes --rationale <why the adverse verdict is overruled>",
  );
});

// CEO ruling 2026-10-25 (必修 1): rows frozen at `submitted` on the review node before the
// automatic corridor are a registered stock disposal, and the guidance must point at that
// registration instead of exits the shape cannot take (contract migration cannot lift a frozen
// cut's review gate).
test("a legacy submitted review cut points at the registered stock disposal, not contract migration", () => {
  // Real old-shape input: the pre-corridor kernel recorded task.status "submitted" on the
  // execution_submitted envelope itself, and replay owns the recorded status
  // (task-lifecycle-replay's submit atomicity accepts both), so reducing the fixture's real
  // submit envelope with the legacy recorded status reproduces the stored row as an upgraded
  // ledger reads it.
  const [created, started, submitEvent] = fixture.events,
    legacyEvents = [
      created!,
      started!,
      {
        ...submitEvent!,
        payload: {
          ...submitEvent!.payload,
          task: { ...submitEvent!.payload.task, status: "submitted" as const },
        },
      },
    ],
    legacy = legacyEvents.reduce(reduceTaskEvent, emptyTaskLifecycleSnapshot());
  assert.equal(submitEvent?.type, "execution_submitted", "fixture must expose its real submit envelope");
  assert.equal(legacy.task?.status, "submitted");
  assert.equal(legacy.task?.currentNode, "review");
  const result = taskCompletionNext(legacy, context);
  assert.equal(result.blocker?.code, "not_in_review");
  assert.match(result.next!.reason, /docs-release\/data-format-migrations\.md/u);
  assert.match(result.next!.reason, /forward it with a pre-upgrade version before upgrading/u);
  assert.match(result.next!.reason, /supersede the task/u);
  assert.doesNotMatch(result.next!.reason, /migrate its contract/u);
  // INDEX renders the action line only; it must not advise review dispatch or contract migration.
  const index = rematerializeTaskDocuments({
    snapshot: legacy,
    packagePath: "tasks/task-1",
    paths: ["tasks/task-1/INDEX.md"],
    currentDocuments: [],
  })[0]!.body;
  assert.match(index, /ha task show task-1/u);
  assert.doesNotMatch(index, /dispatch-review|contract migrate/u);
});

test("an executorless review without dispatch lineage names an executable independent-review step", () => {
  const inReview = at(3),
    executorless = {
      ...inReview,
      executions: inReview.executions.map((execution) => ({
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
    reviewLifted = { review: false, consent: false, factDisposition: false };
  // A recorded review already judged independence, so the chain moves on to the remaining gates.
  assert.notEqual(taskCompletionNext(withoutExecutor(at(5)), context).blocker?.code, "executor_missing");
  // With the review gate lifted no reviewer independence is judged at all.
  assert.notEqual(
    taskCompletionNext(withoutExecutor(at(3)), { ...context, closeoutGates: reviewLifted }).blocker?.code,
    "executor_missing",
  );
});

test("INDEX next uses the same completion judgment for strict and lightweight profiles", () => {
  const submitted = at(3),
    index = (
      snapshot: typeof submitted,
      completionContext: typeof context & {
        readonly closeoutGates: Readonly<Record<"review" | "consent" | "fact" | "factDisposition", boolean>>;
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
      closeoutGates: { review: true, consent: true, factDisposition: true },
    },
    lightweight = {
      ...context,
      closeoutGates: { review: false, consent: false, factDisposition: false },
    };
  assert.match(index(submitted, strict), /ha task dispatch-review task-1/u);
  assert.match(index(submitted, lightweight), /ha task complete task-1/u);
});
