// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { applyTransition, canonicalGateReceipts, compileCompletionGateWitness, completionBlockers, eventObjectTarget, normalizeTaskLifecycleCommand, serializeCanonicalEvent, sha256Text, type TaskEventV1 } from "../../kernel/src/index.ts";
import { makeTaskEventStore, makeTaskProjection, reduceTaskEvent, serializeEventHead, serializeTaskEvent, TASK_LEASE_BROKER_CONTRACT } from "../../kernel/test/store/task-lifecycle-runtime.ts";
import { makeTaskLifecycleService, TaskLifecycleOperationConflict } from "../src/task-lifecycle-service.ts";
import { fixtureDispatchRead, lifecycleHarness, replayGraph } from "./task-lifecycle-test-harness.ts";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: "codex" } };
const command = <C extends Parameters<typeof normalizeTaskLifecycleCommand>[1]>(rootDir: string, intent: C, meta: { readonly eventId: string; readonly workspaceRevision: number; readonly occurredAt: string }, expectedRevision = meta.workspaceRevision - 1) =>
  ({ ...normalizeTaskLifecycleCommand({ workspaceId: rootDir, actor, source: "local", expectedRevision }, intent), ...meta });

test("completion blocker matrix returns one canonical next for every substantive gate", async () => {
  const harness = lifecycleHarness();
  try {
    const created = await harness.create(), started = await harness.start("execution-1"), submitted = await harness.submit("execution-1"), reviewed = await harness.review("execution-1", "acceptance", "approved"), consented = await harness.consent("execution-1");
    const ready = { closeout: "ready" as const, closeoutPath: "tasks/task-1/closeout.md", eligibleDirtyPaths: [] as string[] };
    const withGates = (gateIds: readonly string[]) => ({ ...consented.snapshot, task: { ...consented.snapshot.task!, completionGateIds: gateIds } });
    const orphanMilestone = {
      ...consented.snapshot,
      task: { ...consented.snapshot.task!, taskClass: "milestone" as const },
      decisionRelations: [],
    };
    const cases = [
      ["not_in_review", started.snapshot, ready],
      ["closeout_placeholder", consented.snapshot, { ...ready, closeout: "placeholder" as const }],
      ["review_missing", submitted.snapshot, ready],
      ["consent_missing", reviewed.snapshot, ready],
      ["ci_missing", withGates(["ci"]), ready],
      ["code_doc_missing", withGates(["code-doc-reconciliation"]), ready],
      ["decision_lineage_missing", orphanMilestone, ready],
      ["lease_held", { ...consented.snapshot, lease: started.snapshot.lease }, ready],
      ["doc_sync_required", consented.snapshot, { ...ready, closeout: "dirty_eligible" as const, eligibleDirtyPaths: ["tasks/task-1/closeout.md"] }]
    ] as const;
    assert.equal(created.snapshot.task?.status, "planned");
    for (const [code, snapshot, context] of cases) {
      const blockers = completionBlockers(snapshot, "execution-1", context);
      assert.deepEqual(blockers.map((blocker) => blocker.code), [code], code);
      assert.equal((blockers[0]?.next.command.length ?? 0) > 0, true, code);
      assert.equal((blockers[0]?.next.reason.length ?? 0) > 0, true, code);
    }
    // The lineage blocker names the missing edge with the exact command that writes it.
    const lineage = completionBlockers(orphanMilestone, "execution-1", ready)[0]!;
    assert.equal(lineage.next.command, "ha decision relate <decision-id> --anchor <claim-id> --type derives --target task/task-1 --rationale <why this decision authorises the task>");
    const reportOnly = {
      ...withGates(["code-doc-reconciliation"]),
      executions: consented.snapshot.executions.map((execution) => ({
        ...execution,
        submission: execution.submission
          ? { ...execution.submission, deliverables: ["tasks/task-1-audit/artifacts/report.md"] }
          : null,
      })),
    };
    assert.deepEqual(completionBlockers(reportOnly, "execution-1", ready), []);
    const reportExecution = reportOnly.executions.find((execution) => execution.executionId === "execution-1")!;
    assert.deepEqual(canonicalGateReceipts({
      ...reportOnly,
      codeDocWitnesses: [{
        schema: "code-doc-witness/v1",
        witnessId: "fabricated-before-fix",
        taskId: "task-1",
        executionId: "execution-1",
        commitSha: reportExecution.submission!.commitSha,
        iteration: 0,
        paths: ["README.md"],
        actor,
        source: "local",
        reconciledAt: "2026-08-11T00:00:00.000Z",
      }],
    }, reportExecution), [], "an obsolete fabricated witness is not required proof for a report-only cut");
    assert.deepEqual(completionBlockers(consented.snapshot, "execution-1", ready), []);
  } finally { harness.cleanup(); }
});

test("canonical checker receipt becomes a content-cut gate witness before CompleteTask", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create(); await harness.start("execution-1"); await harness.submit("execution-1"); await harness.review("execution-1", "acceptance", "approved"); const consented = await harness.consent("execution-1");
    const snapshot = { ...consented.snapshot, task: { ...consented.snapshot.task!, completionGateIds: ["ci"] } };
    const input = { snapshot, taskId: "task-1", executionId: "execution-1", gateId: "ci", result: "pass" as const, receiptId: "op-ci", checkerId: "standard", commitSha: "a".repeat(40), iteration: 0, actor, source: "local" as const, opId: "op-ci", eventId: "event-ci", workspaceRevision: snapshot.revision + 1, occurredAt: "2026-08-11T00:10:00.000Z", packagePath: null, currentDocuments: [] };
    const compiled = compileCompletionGateWitness(input);
    assert.deepEqual(compiled.event.payload.witness, { schema: "completion-gate-witness/v1", witnessId: "gate-op-ci", receiptId: "op-ci", checkerId: "standard", gateId: "ci", result: "pass", taskId: "task-1", executionId: "execution-1", commitSha: "a".repeat(40), iteration: 0, actor, source: "local", verifiedAt: "2026-08-11T00:10:00.000Z" });
    const verified = reduceTaskEvent(snapshot, compiled.event), complete = command(harness.rootDir, { type: "CompleteTask" as const, taskId: "task-1", executionId: "execution-1" }, { eventId: "event-complete", workspaceRevision: verified.revision + 1, occurredAt: "2026-08-11T00:11:00.000Z" }, verified.revision), proof = { capability: "task-complete@v1" as const, capabilityRef: "cap-complete", actorRole: "owner" as const, noActiveLease: true as const, gateReceipts: [{ gateId: "ci", receiptRef: "event:op-ci", result: "pass" as const, executionId: "execution-1", commitSha: "a".repeat(40), iteration: 0 as const }] };
    const withFailedHistory = { ...verified, gateWitnesses: [{ ...compiled.event.payload.witness, witnessId: "gate-op-ci-fail", receiptId: "op-ci-fail", result: "fail" } as unknown as typeof compiled.event.payload.witness, ...verified.gateWitnesses] };
    assert.deepEqual(withFailedHistory.gateWitnesses.map(({ result }) => result), ["fail", "pass"]); assert.doesNotThrow(() => applyTransition(withFailedHistory, complete, proof)); assert.throws(() => applyTransition(verified, complete, { ...proof, gateReceipts: [{ ...proof.gateReceipts[0]!, receiptRef: "event:forged" }] }), /L2-verified/u);
    assert.throws(() => reduceTaskEvent(snapshot, { ...compiled.event, opId: "op-tampered" }), /canonical event receipt/u);
    assert.throws(() => compileCompletionGateWitness({ ...input, commitSha: "b".repeat(40) }), /execution cut/u);
  } finally { harness.cleanup(); }
});

test("transition service freezes targets and makes create/start idempotent by opId payload", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lifecycle-service-"));
  let projection: ReturnType<typeof makeTaskProjection> | undefined;
  try {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
    projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" });
    const service = makeTaskLifecycleService({
      eventStore,
      projection: { ...projection, read: (taskId) => fixtureDispatchRead(projection!, taskId) },
    });
    const create = command(rootDir, { type: "CreateReplayTask" as const, taskId: "task-1", title: "Replay task", taskClass: "standard" as const, graph: replayGraph,
      completionGateIds: [], presetSnapshotDigest: null }, { eventId: "event-create", workspaceRevision: 1, occurredAt: "2026-08-11T00:00:00.000Z" });
    const createProof = { taskIdUnique: true as const, actorBinding: actor };
    const created = await service.execute(create, createProof);

    assert.equal(created.outcome, "applied");
    assert.equal((await service.execute(create, createProof)).revision, 1);
    assert.equal(Object.isFrozen(created.frozenPlan), true);
    assert.equal(Object.isFrozen(created.frozenPlan.targets), true);
    await assert.rejects(service.execute({ ...create, title: "Different" }, createProof), TaskLifecycleOperationConflict);

    const started = await service.execute(command(rootDir, {
      type: "StartExecution", taskId: "task-1", executionId: "execution-1"
    }, { eventId: "event-start", workspaceRevision: 2, occurredAt: "2026-08-11T00:01:00.000Z" }), {
      actorBinding: actor,
      reservation: { taskId: "task-1", executionId: "execution-1", expiresAt: "2026-08-11T01:00:00.000Z", ttlMs: 1_800_000,
        previousHolder: null, reason: "initial_claim", version: 0 }
    });

    assert.equal(started.outcome, "applied");
    assert.equal(started.snapshot.lease?.phase, "held");
    assert.equal(started.snapshot.executions[0]?.state, "active");
    assert.equal(JSON.stringify(eventStore.read().events).includes("credential"), false);
  } finally {
    projection?.close(); rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("transition service publishes aggregate-authored task status idempotently", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lifecycle-status-service-"));
  let projection: ReturnType<typeof makeTaskProjection> | undefined;
  try {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
    projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" });
    const service = makeTaskLifecycleService({ eventStore, projection });
    const create = command(rootDir, { type: "CreateReplayTask" as const, taskId: "task-1", title: "Status task", taskClass: "standard" as const, graph: replayGraph,
      completionGateIds: [], presetSnapshotDigest: null }, { eventId: "event-create", workspaceRevision: 1, occurredAt: "2026-08-11T00:00:00.000Z" });
    await service.execute(create, { taskIdUnique: true, actorBinding: actor });
    const block = command(rootDir, { type: "TransitionTask" as const, taskId: "task-1", status: "blocked" as const, reason: "Waiting on scope", force: true },
      { eventId: "event-block", workspaceRevision: 2, occurredAt: "2026-08-11T00:01:00.000Z" });
    const first = await service.execute(block, {}), second = await service.execute(block, {});
    assert.equal(first.event?.type, "task_transitioned"); assert.deepEqual(second, first);
    const unblock = command(rootDir, { type: "TransitionTask" as const, taskId: "task-1", status: "active" as const, reason: "", force: true },
      { eventId: "event-unblock", workspaceRevision: 3, occurredAt: "2026-08-11T00:02:00.000Z" });
    const unblocked = await service.execute(unblock, {}), retried = await service.execute(unblock, {});
    assert.equal(unblocked.snapshot.task?.status, "active"); assert.equal(unblocked.event?.type, "task_transitioned"); assert.equal(unblocked.event?.payload.mutation.reason, "Explicit lifecycle transition to active"); assert.deepEqual(retried, unblocked);
    assert.equal(eventStore.read().events.filter((event) => event.schema === "task-event/v1").length, 3);
  } finally {
    projection?.close(); rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test("transition republishes a historical task without its retired longRunning metadata", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lifecycle-retired-metadata-"));
  let projection: ReturnType<typeof makeTaskProjection> | undefined;
  try {
    initRepo(rootDir);
    const historical = oldTaskEvent(1), metadata = { idempotencyKey: null, parentTaskId: null, workKind: "fix" as const, riskTier: "medium" as const, urgency: null, verticalId: "software/coding", presetId: "standard-task", profileId: "baseline", moduleKey: null, slug: "legacy-task", surfaces: [] as readonly string[], fromLegacyId: null };
    const legacy = { ...historical, taskId: "task-legacy", payload: { ...historical.payload, task: { ...historical.payload.task, taskId: "task-legacy", title: "Legacy task", metadata: { ...metadata, longRunning: false } } } } as unknown as typeof historical;
    const eventBody = serializeCanonicalEvent(legacy), target = path.join(rootDir, eventObjectTarget(legacy.opId)); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, eventBody); writeFileSync(path.join(rootDir, "harness/events/head.json"), serializeEventHead({ revision: 1, opId: legacy.opId, eventDigest: `sha256:${sha256Text(eventBody)}` })); git(rootDir, "add", "harness/events"); git(rootDir, "commit", "--quiet", "-m", "historical task fixture");
    const eventStore = makeTaskEventStore({ repoId: "legacy-task", rootDir }); projection = makeTaskProjection({ rootDir, eventStore }); projection.rebuild(); const service = makeTaskLifecycleService({ eventStore, projection });
    const block = command(rootDir, { type: "TransitionTask" as const, taskId: legacy.taskId, status: "blocked" as const, reason: "Waiting on scope", force: true }, { eventId: "event-block", workspaceRevision: 2, occurredAt: "2026-08-11T00:01:00.000Z" }, 1);
    const receipt = await service.execute(block, {}), written = eventStore.readTaskEvent(block.opId);
    assert.equal(receipt.outcome, "applied"); assert.equal(receipt.snapshot.task?.status, "blocked"); assert.equal(Object.hasOwn(receipt.snapshot.task?.metadata ?? {}, "longRunning"), false);
    assert.equal(written?.schema === "task-event/v1" && Object.hasOwn(written.payload.task.metadata ?? {}, "longRunning"), false);
    const contract = projection.readDocument("tasks/task-legacy-legacy-task/task-contract.json").document; assert.ok(contract); assert.equal(Object.hasOwn(JSON.parse(contract.body).metadata, "longRunning"), false);
  } finally { projection?.close(); rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
});

test("reinstate rolls a cancelled task back to planned, active, or in_review with an audited reason", async () => {
  const harness = lifecycleHarness();
  try {
    const transition = (status: "planned" | "active" | "in_review" | "cancelled", reason: string, force = false) => {
      const revision = harness.eventStore.read().revision + 1;
      return harness.service.execute(command(harness.rootDir, { type: "TransitionTask" as const, taskId: "task-1", status, reason, force }, { eventId: `event-reinstate-${revision}`, workspaceRevision: revision, occurredAt: `2026-08-11T00:${String(revision).padStart(2, "0")}:00.000Z` }), {});
    };

    // planned: the CH6 shape — a committed task cancelled in error and rolled back.
    await harness.create();
    await transition("cancelled", "CH6 batch cleanup cancelled in error", true);
    await assert.rejects(transition("planned", ""), /auditable reason/u, "reinstate is audit-first: an empty reason never publishes");
    const planned = await transition("planned", "Owner adjudicated rollback of the batch cancellation");
    assert.equal(planned.outcome, "applied");
    assert.equal(planned.snapshot.task?.status, "planned");
    assert.equal(harness.projection.read("task-1").snapshot.task?.status, "planned");
    assert.equal(planned.event?.type, "task_transitioned");
    assert.equal(planned.event?.payload.mutation.reason, "Owner adjudicated rollback of the batch cancellation");

    // active: the owner adjudicates the recorded executing state as the restore point.
    await transition("cancelled", "Second erroneous cancellation", true);
    const active = await transition("active", "Restore the recorded executing state");
    assert.equal(active.outcome, "applied");
    assert.equal(active.snapshot.task?.status, "active");
    assert.equal(harness.projection.read("task-1").snapshot.task?.status, "active");

    // in_review: a task cancelled mid-review returns to the review position it held.
    await harness.start("execution-1");
    await harness.submit("execution-1");
    await transition("cancelled", "Cancelled while awaiting review", true);
    const reviewed = await transition("in_review", "Resume the interrupted review");
    assert.equal(reviewed.outcome, "applied");
    assert.equal(reviewed.snapshot.task?.status, "in_review");
    assert.equal(harness.projection.read("task-1").snapshot.task?.status, "in_review");

    // done keeps its terminal integrity: completion, not compensation, owns its reversal.
    await harness.review("execution-1", "acceptance", "approved");
    await harness.consent("execution-1");
    await harness.complete("execution-1");
    assert.equal((await harness.service.read("task-1")).snapshot.task?.status, "done");
    await assert.rejects(transition("planned", "Attempted done rollback"), /no lifecycle transition accepts TransitionTask/u);
  } finally {
    harness.cleanup();
  }
});

test("terminal lifecycle states clear a prior task pin", async () => {
  const harness = lifecycleHarness();
  try {
    const created = await harness.create();
    const cancelled = applyTransition({ ...created.snapshot, task: { ...created.snapshot.task!, pinned: true } }, command(harness.rootDir, {
      type: "TransitionTask" as const, taskId: "task-1", status: "cancelled" as const, reason: "No longer being worked", force: true
    }, { eventId: "event-cancel-pin", workspaceRevision: created.snapshot.revision + 1, occurredAt: "2026-08-11T00:01:00.000Z" }, created.snapshot.revision), {});
    assert.equal(cancelled.snapshot.task?.status, "cancelled");
    assert.equal(cancelled.snapshot.task?.pinned, false);

    await harness.start("execution-1"); await harness.submit("execution-1"); await harness.review("execution-1", "acceptance", "approved"); const consented = await harness.consent("execution-1");
    const completed = applyTransition({ ...consented.snapshot, task: { ...consented.snapshot.task!, pinned: true } }, command(harness.rootDir, {
      type: "CompleteTask" as const, taskId: "task-1", executionId: "execution-1"
    }, { eventId: "event-complete-pin", workspaceRevision: consented.snapshot.revision + 1, occurredAt: "2026-08-11T00:10:00.000Z" }, consented.snapshot.revision), {
      capability: "task-complete@v1", capabilityRef: "cap-complete-pin", actorRole: "owner", noActiveLease: true, gateReceipts: []
    });
    assert.equal(completed.snapshot.task?.status, "done");
    assert.equal(completed.snapshot.task?.pinned, false);
  } finally {
    harness.cleanup();
  }
});

test("second distinct task create uses aggregate revision zero in a non-empty workspace", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lifecycle-two-tasks-"));
  let projection: ReturnType<typeof makeTaskProjection> | undefined;
  try {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
    projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" });
    const service = makeTaskLifecycleService({ eventStore, projection });
    const create = (taskId: string, title: string, revision: number) => command(rootDir, {
      type: "CreateReplayTask" as const, taskId, title, taskClass: "standard" as const, graph: replayGraph, completionGateIds: [], presetSnapshotDigest: null
    }, { eventId: `event-create-${revision}`, workspaceRevision: revision, occurredAt: `2026-08-11T00:0${revision}:00.000Z` }, 0);
    await service.execute(create("task-1", "First task", 1), { taskIdUnique: true, actorBinding: actor });
    const second = await service.execute(create("task-2", "Second task", 2), { taskIdUnique: true, actorBinding: actor });
    assert.equal(second.snapshot.task?.taskId, "task-2");
    assert.equal(second.snapshot.revision, 2);
    assert.equal(eventStore.read().events.length, 2);
    await assert.rejects(() => service.execute(create("task-2", "Duplicate task", 3), { taskIdUnique: true, actorBinding: actor }));
  } finally {
    projection?.close(); rmSync(rootDir, { recursive: true, force: true });
  }
});

test("pending without an event uses an honest receipt", async () => {
  let appendCalls = 0;
  const snapshot = { revision: 0, task: null, executions: [], reviews: [], edgesTaken: [], lease: null } as const;
  const read = { status: "pending" as const, snapshot, watermark: 0, sourceRevision: 1, warnings: [] };
  const service = makeTaskLifecycleService({
    eventStore: { readTaskEvent: () => null, append: (candidate) => { appendCalls += 1; return { status: "applied" as const, event: candidate.event, revision: candidate.event.workspaceRevision }; } },
    projection: { read: () => read, readTaskOperation: () => null, currentLease: () => null,
      reserveLease: (lease) => lease, activateLease: (lease) => lease, renewLease: (lease) => lease, releaseLease: (lease) => lease,
      apply: () => ({ metrics: { reducedItems: 0 } }) }
  });
  const start = command("workspace", { type: "StartExecution" as const, taskId: "task-pending", executionId: "execution-pending" },
    { eventId: "event-pending", workspaceRevision: 1, occurredAt: "2026-08-12T00:00:00.000Z" });
  const receipt = await service.execute(start, { actorBinding: actor,
    reservation: { taskId: start.taskId, executionId: start.executionId, expiresAt: "2026-08-12T00:30:00.000Z", ttlMs: 1_800_000 } });

  assert.equal(appendCalls, 0);
  assert.equal(receipt.outcome, "indeterminate");
  assert.equal(receipt.code, "operation_not_published");
  assert.equal(receipt.origin, "N/A");
  assert.equal("evidence" in receipt, false);
  assert.equal("revision" in receipt, false);
  assert.equal("proof" in receipt, false);
  assert.match(receipt.nextAction ?? "", /retry.*read/iu);
});

test("missing canonical append cannot be hidden by a ready projection", async () => {
  const initial = { revision: 0, task: null, executions: [], reviews: [], edgesTaken: [], lease: null } as const;
  let snapshot = initial;
  const read = () => ({ status: "ready" as const, snapshot, packagePath: null, watermark: snapshot.revision, sourceRevision: snapshot.revision, warnings: [] });
  const service = makeTaskLifecycleService({
    eventStore: { readTaskEvent: () => null, append: (candidate) => ({ status: "applied" as const, revision: candidate.event.workspaceRevision }) },
    projection: {
      read, readDocument: () => ({ document: null }), readTaskOperation: () => null, currentLease: () => null,
      reserveLease: (lease) => lease, activateLease: (lease) => lease, renewLease: (lease) => lease, releaseLease: (lease) => lease,
      apply: (event) => { snapshot = reduceTaskEvent(snapshot, event); return { metrics: { reducedItems: 1 } }; }
    }
  });
  const create = command("workspace", { type: "CreateReplayTask" as const, taskId: "task-missing-append", title: "Missing append", taskClass: "standard" as const,
    graph: replayGraph, completionGateIds: [], presetSnapshotDigest: null }, { eventId: "event-missing-append", workspaceRevision: 1, occurredAt: "2026-08-12T00:00:00.000Z" }, 0);
  const receipt = await service.execute(create, { taskIdUnique: true, actorBinding: actor });

  assert.equal(receipt.outcome, "pending");
  assert.equal(receipt.proof?.canonicalVisible, false);
  assert.equal(receipt.proof?.durable, false);
  assert.match(receipt.nextAction ?? "", /canonical event publication is missing/u);
});

// Every phase of an independent write is O(old events) by construction: store init builds its
// known-op set from the whole event tree, each bounded catch-up round re-parses that same tree to
// slice a bounded window out of it, and the git commit writes a tree holding every event file.
// No phase is flat, so neither an absolute millisecond budget nor a fixed ratio against a shorter
// history can be the gate -- the first measures the runner, the second measures git
// (dec_01KY6X4J486MZ35RW1QN51V2V1: relative overhead, not absolute milliseconds).
// What bounded catch-up promises is narrower than "flat": it never READS every old event.
// accessedItems cannot witness that promise, because a path that reads the whole stream without
// touching the batch window still reports the bounded window size -- which is why a timing
// comparison has to carry it.
// So the gate is a positive control rather than a constant: the same write runs twice over the
// same fixture, in one process and one time window, once through the bounded read path and once
// through a control that reads every old event twice. The control's explicit read count is the
// positive signal; timing remains diagnostic because repository setup dominates these samples.
// Both arms report accessedItems <= the configured 4096-item catch-up bound, so only the
// read-cost comparison exposes that regression.
test("10,000 old events do not block a new write", async (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-lifecycle-10k-"));
  try {
    const historyRoot = path.join(parent, "history"), historyEvents = 10_000;
    seedOldEvents(historyRoot, historyEvents);
    const samples: Record<ReadMode, Awaited<ReturnType<typeof independentWrite>>[]> = { bounded: [], "whole-history": [] }, ratios: number[] = [];
    let revision = historyEvents;
    for (let round = 1; round <= 5; round += 1) {
      // Keep each pair adjacent and alternate which arm pays the process warm-up.
      const order: readonly ReadMode[] = round % 2 === 0 ? ["whole-history", "bounded"] : ["bounded", "whole-history"];
      let boundedArm: Awaited<ReturnType<typeof independentWrite>> | undefined, wholeHistoryArm: Awaited<ReturnType<typeof independentWrite>> | undefined;
      for (const mode of order) {
        revision += 1;
        const arm = await independentWrite(historyRoot, revision, `${round}-${mode}`, mode);
        samples[mode].push(arm); if (mode === "bounded") boundedArm = arm; else wholeHistoryArm = arm;
        context.diagnostic(
          `independent-write round=${round} mode=${mode} readMs=${arm.readMs.toFixed(3)} ` +
          `storeInitMs=${arm.storeInitMs.toFixed(3)} appendMs=${arm.appendMs.toFixed(3)} ` +
          `applyMs=${arm.applyMs.toFixed(3)} accessedItems=${arm.maxAccessedItems} ` +
          `fullHistoryReads=${arm.fullHistoryReads} ` +
          `initial=${arm.initialStatus}:${arm.initialWatermark}/${arm.initialSourceRevision}`,
        );
        assert.notEqual(arm.published, null, "the independent write must enter L1");
        assert.equal(
          arm.outcome,
          arm.initialStatus === "pending" ? "pending" : "applied",
          "L1 may lead the bounded L2 catch-up only while the initial read is pending",
        );
        // Both arms stay inside the item bound -- including the one that reads every old event --
        // so this assertion cannot stand in for the read-cost comparison below.
        assert.equal(arm.maxAccessedItems <= 4096, true, `catch-up accessed ${arm.maxAccessedItems} event files`);
      }
      assert.ok(boundedArm);
      assert.ok(wholeHistoryArm);
      assert.equal(boundedArm.fullHistoryReads, 0,
        "the bounded path must not read the whole event history");
      if (wholeHistoryArm.fullHistoryReads > 0)
        assert.equal(wholeHistoryArm.fullHistoryReads > boundedArm.fullHistoryReads, true,
          "the whole-history positive control must perform extra full-stream reads");
      ratios.push(wholeHistoryArm.readMs / boundedArm.readMs);
    }
    const describe = (values: readonly number[]) => `p50=${median(values).toFixed(3)}ms min=${Math.min(...values).toFixed(3)}ms max=${Math.max(...values).toFixed(3)}ms`, metric = (mode: ReadMode, key: "elapsedMs" | "storeInitMs" | "readMs" | "appendMs" | "applyMs") => samples[mode].map((sample) => sample[key]);
    for (const mode of ["bounded", "whole-history"] as const) context.diagnostic(`independent-write-samples mode=${mode} samples=${samples[mode].length} total(${describe(metric(mode, "elapsedMs"))}) storeInit(${describe(metric(mode, "storeInitMs"))}) read(${describe(metric(mode, "readMs"))}) append(${describe(metric(mode, "appendMs"))}) apply(${describe(metric(mode, "applyMs"))})`);
    const orderedRatios = [...ratios].sort((left, right) => left - right), ratio = median(ratios); context.diagnostic(`independent-write-ratio=paired-whole-history-over-bounded samples=${ratios.length} p50=${ratio.toFixed(3)}x min=${orderedRatios[0]!.toFixed(3)}x max=${orderedRatios.at(-1)!.toFixed(3)}x`);
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function seedOldEvents(rootDir: string, count: number): void {
  mkdirSync(rootDir, { recursive: true });
  initRepo(rootDir);
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "config", "maintenance.auto", "false");
  const eventsRoot = path.join(rootDir, "harness/events");
  mkdirSync(eventsRoot, { recursive: true });
  let last = oldTaskEvent(1);
  for (let revision = 1; revision <= count; revision += 1) {
    last = oldTaskEvent(revision);
    const eventPath = path.join(rootDir, eventObjectTarget(last.opId));
    mkdirSync(path.dirname(eventPath), { recursive: true });
    writeFileSync(eventPath, serializeTaskEvent(last));
  }
  const lastBytes = serializeTaskEvent(last);
  writeFileSync(path.join(eventsRoot, "head.json"), serializeEventHead({ revision: last.workspaceRevision, opId: last.opId,
    eventDigest: `sha256:${createHash("sha256").update(lastBytes).digest("hex")}` }));
  git(rootDir, "add", "--", "harness/events");
  git(rootDir, "commit", "--quiet", "-m", `${count} old event fixture`);
  git(rootDir, "update-ref", "refs/ha/canonical", "HEAD");
}

type ReadMode = "bounded" | "whole-history";
function median(values: readonly number[]): number { const ordered = [...values].sort((left, right) => left - right); return ordered[Math.floor(ordered.length / 2)]!; }

async function independentWrite(rootDir: string, revision: number, label: string, mode: ReadMode) {
  const started = performance.now();
  const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
  const storeReady = performance.now();
  const phase = { readMs: 0, appendMs: 0, applyMs: 0, maxAccessedItems: 0, fullHistoryReads: 0 };
  const boundedEventStore = {
    ...eventStore,
    read: () => {
      phase.fullHistoryReads += 1;
      return eventStore.read();
    },
    readBatch: (cursor: string | null, maxItems: number) => {
    // The failure mode the item bound cannot see: read every old event, then hand back the same
    // bounded window, so accessedItems is unchanged and only the explicit read count notices it.
    if (mode === "whole-history") {
      phase.fullHistoryReads += 2;
      boundedEventStore.read();
      boundedEventStore.read();
    }
    const batch = eventStore.readBatch(cursor, maxItems);
    phase.maxAccessedItems = Math.max(phase.maxAccessedItems, batch.accessedItems);
    return batch;
    },
  };
  const projection = makeTaskProjection({ rootDir, eventStore: boundedEventStore, now: () => "2026-08-12T00:00:00.000Z" });
  let initialStatus: "ready" | "pending" | undefined;
  let initialWatermark: number | undefined;
  let initialSourceRevision: number | undefined;
  const service = makeTaskLifecycleService({
    eventStore: { ...boundedEventStore, append: (candidate) => {
      const phaseStarted = performance.now(); try { return eventStore.append(candidate); } finally { phase.appendMs += performance.now() - phaseStarted; }
    } },
    projection: {
      ...projection,
      read: (taskId) => {
        const phaseStarted = performance.now();
        try {
          const value = projection.read(taskId);
          if (initialStatus === undefined) {
            initialStatus = value.status;
            initialWatermark = value.watermark;
            initialSourceRevision = value.sourceRevision;
          }
          return value;
        } finally {
          phase.readMs += performance.now() - phaseStarted;
        }
      },
      apply: (candidate) => {
        const phaseStarted = performance.now();
        try {
          return projection.apply(candidate);
        } finally {
          phase.applyMs += performance.now() - phaseStarted;
        }
      },
    },
  });
  const create = command(rootDir, { type: "CreateReplayTask" as const, taskId: `task-new-${label}`, title: "New independent task", taskClass: "standard" as const,
    graph: replayGraph, completionGateIds: [], presetSnapshotDigest: null }, { eventId: `event-new-${label}`, workspaceRevision: revision,
    occurredAt: "2026-08-12T00:00:00.000Z" }, 0);
  const receipt = await service.execute(create, { taskIdUnique: true, actorBinding: actor });
  projection.close();
  return {
    elapsedMs: performance.now() - started,
    storeInitMs: storeReady - started,
    ...phase,
    outcome: receipt.outcome,
    published: eventStore.readEvent(create.opId),
    initialStatus,
    initialWatermark,
    initialSourceRevision,
  };
}

test("transition service replays reject through a new Execution before completion", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    await harness.submit("execution-1");
    await harness.review("execution-1", "anti_entropy", "changes_requested");
    await harness.start("execution-2");
    await harness.submit("execution-2");
    await harness.review("execution-2", "anti_entropy", "approved");
    await harness.consent("execution-2");
    const completed = await harness.complete("execution-2");

    assert.equal(completed.snapshot.task?.status, "done");
    assert.equal(completed.snapshot.task?.iteration, 1);
    assert.deepEqual(completed.snapshot.executions.map((execution) => execution.state), ["changes_requested", "accepted"]);
    assert.deepEqual(completed.snapshot.edgesTaken.map((edge) => edge.on), ["submitted", "changes_requested", "submitted"]);
  } finally {
    harness.cleanup();
  }
});

test("second lifecycle claim uses monotonic lease CAS", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    await harness.submit("execution-1");
    await harness.review("execution-1", "anti_entropy", "changes_requested");
    await harness.start("execution-2");

    const claims = harness.eventStore.read().events.filter((candidate) => candidate.type === "execution_started");
    assert.equal(claims.length, 2);
    const first = claims[0]!;
    const second = claims[1]!;
    if (first.type !== "execution_started" || second.type !== "execution_started") throw new Error("fixture requires claim events");
    assert.equal(second.payload.lease.version > first.payload.lease.version, true);
    assert.deepEqual(second.payload.previousHolder, {
      taskId: first.taskId, executionId: first.payload.execution.executionId, actor: first.actor, source: first.source
    });
    assert.equal(second.payload.reason, "same_principal_reconnect");
    assert.deepEqual(harness.projection.currentLease("task-1"), second.payload.lease);
  } finally {
    harness.cleanup();
  }
});

test("SQLite/response killpoints reconstruct the exact applied receipt by opId without another commit", async () => {
  for (const point of ["after_sqlite_commit", "before_response_write", "after_response_write"] as const) {
    const rootDir = mkdtempSync(path.join(tmpdir(), `ha-response-${point}-`));
    let projection: ReturnType<typeof makeTaskProjection> | undefined;
    try {
      initRepo(rootDir);
      const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
      projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" });
      let armed = true;
      const interrupted = makeTaskLifecycleService({ eventStore, projection, killpoint: (candidate) => {
        if (armed && candidate === point) { armed = false; throw new Error(`killpoint:${point}`); }
      } });
      const create = command(rootDir, { type: "CreateReplayTask" as const, taskId: "task-1", title: "Replay task", taskClass: "standard" as const, graph: replayGraph,
        completionGateIds: [], presetSnapshotDigest: null }, { eventId: "event-create", workspaceRevision: 1, occurredAt: "2026-08-11T00:00:00.000Z" });
      const proof = { taskIdUnique: true as const, actorBinding: actor };
      await assert.rejects(interrupted.execute(create, proof), new RegExp(`killpoint:${point}`, "u"));
      await eventStore.drain();
      const commitCount = git(rootDir, "rev-list", "--count", "refs/ha/canonical").trim();
      const published = eventStore.readTaskEvent(create.opId);
      if (published === null) throw new Error(`${point} did not publish an event`);
      const eventBytes = serializeTaskEvent(published);
      const digest = `sha256:${createHash("sha256").update(eventBytes).digest("hex")}` as const;
      assert.equal(git(rootDir, "show", `refs/ha/canonical:${eventObjectTarget(create.opId)}`), eventBytes);
      assert.equal(git(rootDir, "show", "refs/ha/canonical:harness/events/head.json"), serializeEventHead({ revision: 1, opId: create.opId, eventDigest: digest }));

      const resumed = makeTaskLifecycleService({ eventStore, projection });
      const first = await resumed.execute(create, proof);
      const second = await resumed.execute(create, proof);
      assert.equal(first.outcome, "applied", point);
      assert.deepEqual(second, first, point);
      assert.equal(projection.readOperation(create.opId)?.event.opId, create.opId);
      assert.equal(git(rootDir, "rev-list", "--count", "refs/ha/canonical").trim(), commitCount);
    } finally { projection?.close(); rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
  }
});

test("lease broker capacity ceiling rejects concurrent exhaustion and release restores availability", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lease-capacity-"));
  let projection: ReturnType<typeof makeTaskProjection> | undefined;
  try {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
    projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" });
    const lease = (id: string) => ({ schema: "lease/v1" as const, taskId: `task-${id}`, executionId: `execution-${id}`, actor, source: "local" as const,
      phase: "reserving" as const, expiresAt: "2026-08-11T01:00:00.000Z", ttlMs: 1_800_000, version: 0 });
    for (let index = 0; index < TASK_LEASE_BROKER_CONTRACT.capacity; index += 1) {
      projection.reserveLease(lease(`cap-${index}`), "2026-08-11T00:00:00.000Z");
    }
    assert.throws(() => projection.reserveLease(lease("overflow"), "2026-08-11T00:00:00.000Z"), /capacity.*exhausted/iu);
    projection.releaseLease(projection.currentLease("task-cap-0")!);
    assert.equal(projection.reserveLease(lease("recovered"), "2026-08-11T00:00:00.000Z").taskId, "task-recovered");
  } finally {
    projection?.close(); rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Lifecycle Service Test");
  git(rootDir, "config", "user.email", "service-test@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
}

function oldTaskEvent(revision: number): Extract<TaskEventV1, { readonly type: "task_created" }> {
  const suffix = String(revision).padStart(5, "0");
  const taskId = `task-old-${suffix}`;
  return {
    schema: "task-event/v1", eventId: `event-old-${suffix}`, workspaceRevision: revision, opId: `op-old-${suffix}`, taskId,
    type: "task_created", actor, source: "local", occurredAt: "2026-08-11T00:00:00.000Z",
    payload: { task: { schema: "task/v1", taskId, title: `Old task ${suffix}`, taskClass: "standard", status: "planned", graph: replayGraph,
      currentNode: "implementation", iteration: 0, createdBy: actor, completionGateIds: [], presetSnapshotDigest: null }, documentClaims: [] }
  };
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
