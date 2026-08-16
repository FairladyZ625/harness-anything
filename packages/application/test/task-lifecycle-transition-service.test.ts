// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { applyTransition, compileCompletionGateWitness, completionBlockers, normalizeTaskLifecycleCommand, type TaskEventV1 } from "../../kernel/src/index.ts";
import { makeTaskEventStore, makeTaskProjection, reduceTaskEvent, serializeEventHead, serializeTaskEvent, TASK_LEASE_BROKER_CONTRACT } from "../../kernel/test/store/task-lifecycle-runtime.ts";
import { makeTaskLifecycleService, TaskLifecycleOperationConflict } from "../src/task-lifecycle-service.ts";
import { lifecycleHarness, replayGraph } from "./task-lifecycle-test-harness.ts";

const actor = { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: "codex" } };
const command = <C extends Parameters<typeof normalizeTaskLifecycleCommand>[1]>(rootDir: string, intent: C, meta: { readonly eventId: string; readonly workspaceRevision: number; readonly occurredAt: string }, expectedRevision = meta.workspaceRevision - 1) =>
  ({ ...normalizeTaskLifecycleCommand({ workspaceId: rootDir, actor, source: "local", expectedRevision }, intent), ...meta });

test("completion blocker matrix returns one canonical next for every substantive gate", async () => {
  const harness = lifecycleHarness();
  try {
    const created = await harness.create(), started = await harness.start("execution-1"), submitted = await harness.submit("execution-1"), reviewed = await harness.review("execution-1", "acceptance", "approved"), consented = await harness.consent("execution-1");
    const ready = { closeout: "ready" as const, closeoutPath: "tasks/task-1/closeout.md", eligibleDirtyPaths: [] as string[] };
    const withGates = (gateIds: readonly string[]) => ({ ...consented.snapshot, task: { ...consented.snapshot.task!, completionGateIds: gateIds } });
    const cases = [
      ["not_in_review", started.snapshot, ready],
      ["closeout_placeholder", consented.snapshot, { ...ready, closeout: "placeholder" as const }],
      ["review_missing", submitted.snapshot, ready],
      ["consent_missing", reviewed.snapshot, ready],
      ["ci_missing", withGates(["ci"]), ready],
      ["code_doc_missing", withGates(["code-doc-reconciliation"]), ready],
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
    assert.deepEqual(verified.gateWitnesses, [compiled.event.payload.witness]); assert.doesNotThrow(() => applyTransition(verified, complete, proof)); assert.throws(() => applyTransition(verified, complete, { ...proof, gateReceipts: [{ ...proof.gateReceipts[0]!, receiptRef: "event:forged" }] }), /L2-verified/u);
    assert.throws(() => reduceTaskEvent(snapshot, { ...compiled.event, opId: "op-tampered" }), /canonical event receipt/u);
    assert.throws(() => compileCompletionGateWitness({ ...input, commitSha: "b".repeat(40) }), /execution cut/u);
  } finally { harness.cleanup(); }
});

test("transition service freezes targets and makes create/start idempotent by opId payload", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lifecycle-service-"));
  try {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" });
    const service = makeTaskLifecycleService({ eventStore, projection });
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
    assert.equal(started.snapshot.lease?.phase, "active");
    assert.equal(started.snapshot.executions[0]?.state, "active");
    assert.equal(JSON.stringify(eventStore.read().events).includes("credential"), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("second distinct task create uses aggregate revision zero in a non-empty workspace", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lifecycle-two-tasks-"));
  try {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" });
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
    rmSync(rootDir, { recursive: true, force: true });
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

// An absolute millisecond budget measures the runner, not the write path: it is red on a
// loaded laptop and on a shared CI runner alike, and green on a fast idle machine even if
// the write became linear in the history. What the title claims is that the cost of an
// independent write does not grow with the number of old events, so the gate is the paired
// ratio between two histories measured in the same process and time window
// (dec_01KY6X4J486MZ35RW1QN51V2V1: relative overhead, not absolute milliseconds).
// Measured at load 8-16 on a developer machine: bounded rounds land at 0.88-1.28, while a
// write path that reads every old event without changing accessedItems lands at 1.58-3.06.
test("10,000 old events do not block a new write", async (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-lifecycle-10k-"));
  try {
    const baselineRoot = path.join(parent, "baseline"), historyRoot = path.join(parent, "history"), baselineEvents = 250, historyEvents = 10_000;
    seedOldEvents(baselineRoot, baselineEvents);
    seedOldEvents(historyRoot, historyEvents);
    const ratios: number[] = [];
    for (let round = 1; round <= 3; round += 1) {
      // Alternate which history pays the process warm-up so it cannot bias one arm.
      const leading = round % 2 === 0 ? await independentWrite(historyRoot, historyEvents, round) : null;
      const baseline = await independentWrite(baselineRoot, baselineEvents, round);
      const history = leading ?? await independentWrite(historyRoot, historyEvents, round);
      ratios.push(history.elapsedMs / baseline.elapsedMs);
      context.diagnostic(`independent-write round=${round} baseline(${baselineEvents})=${baseline.elapsedMs.toFixed(3)}ms history(${historyEvents})=${history.elapsedMs.toFixed(3)}ms ratio=${(history.elapsedMs / baseline.elapsedMs).toFixed(3)}`);
      context.diagnostic(`history phases storeInitMs=${history.storeInitMs.toFixed(3)} readMs=${history.readMs.toFixed(3)} appendMs=${history.appendMs.toFixed(3)} applyMs=${history.applyMs.toFixed(3)} checkpoints=${JSON.stringify(history.checkpoints)}`);
      for (const arm of [baseline, history]) {
        assert.notEqual(arm.published, null, "the independent write must enter L1");
        assert.equal(arm.outcome, "pending", "L1 may lead the bounded L2 catch-up");
        assert.equal(arm.maxAccessedItems <= 64, true, `catch-up accessed ${arm.maxAccessedItems} event files`);
      }
    }
    const median = [...ratios].sort((left, right) => left - right)[1]!;
    assert.equal(median < 1.5, true, `40x the old events cost ${median.toFixed(2)}x the write (rounds: ${ratios.map((ratio) => ratio.toFixed(2)).join(", ")})`);
  } finally {
    rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

function seedOldEvents(rootDir: string, count: number): void {
  mkdirSync(rootDir, { recursive: true });
  initRepo(rootDir);
  const eventsRoot = path.join(rootDir, "harness/events");
  mkdirSync(eventsRoot, { recursive: true });
  let last = oldTaskEvent(1);
  for (let revision = 1; revision <= count; revision += 1) {
    last = oldTaskEvent(revision);
    writeFileSync(path.join(eventsRoot, `${last.opId}.json`), serializeTaskEvent(last));
  }
  const lastBytes = serializeTaskEvent(last);
  writeFileSync(path.join(eventsRoot, "head.json"), serializeEventHead({ revision: last.workspaceRevision, opId: last.opId,
    eventDigest: `sha256:${createHash("sha256").update(lastBytes).digest("hex")}` }));
  git(rootDir, "add", "--", "harness/events");
  git(rootDir, "commit", "--quiet", "-m", `${count} old event fixture`);
  git(rootDir, "update-ref", "refs/ha/canonical", "HEAD");
}

async function independentWrite(rootDir: string, oldEvents: number, round: number) {
  const started = performance.now();
  const checkpoints = new Map<string, number>();
  const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir, killpoint: (point) => checkpoints.set(point, performance.now() - started) });
  const storeReady = performance.now();
  const phase = { readMs: 0, appendMs: 0, applyMs: 0, maxAccessedItems: 0 };
  const boundedEventStore = { ...eventStore, readBatch: (cursor: string | null, maxItems: number) => {
    const batch = eventStore.readBatch(cursor, maxItems);
    phase.maxAccessedItems = Math.max(phase.maxAccessedItems, batch.accessedItems);
    return batch;
  } };
  const projection = makeTaskProjection({ rootDir, eventStore: boundedEventStore, now: () => "2026-08-12T00:00:00.000Z" });
  const service = makeTaskLifecycleService({
    eventStore: { ...boundedEventStore, append: (candidate) => {
      const phaseStarted = performance.now(); try { return eventStore.append(candidate); } finally { phase.appendMs += performance.now() - phaseStarted; }
    } },
    projection: { ...projection, read: (taskId) => {
      const phaseStarted = performance.now(); try { return projection.read(taskId); } finally { phase.readMs += performance.now() - phaseStarted; }
    }, apply: (candidate) => {
      const phaseStarted = performance.now(); try { return projection.apply(candidate); } finally { phase.applyMs += performance.now() - phaseStarted; }
    } }
  });
  const create = command(rootDir, { type: "CreateReplayTask" as const, taskId: `task-new-${round}`, title: "New independent task", taskClass: "standard" as const,
    graph: replayGraph, completionGateIds: [], presetSnapshotDigest: null }, { eventId: `event-new-${round}`, workspaceRevision: oldEvents + round,
    occurredAt: "2026-08-12T00:00:00.000Z" }, 0);
  const receipt = await service.execute(create, { taskIdUnique: true, actorBinding: actor });
  return { elapsedMs: performance.now() - started, storeInitMs: storeReady - started, ...phase, checkpoints: Object.fromEntries(checkpoints),
    outcome: receipt.outcome, published: eventStore.readEvent(create.opId) };
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
    try {
      initRepo(rootDir);
      const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
      const projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" });
      let armed = true;
      const interrupted = makeTaskLifecycleService({ eventStore, projection, killpoint: (candidate) => {
        if (armed && candidate === point) { armed = false; throw new Error(`killpoint:${point}`); }
      } });
      const create = command(rootDir, { type: "CreateReplayTask" as const, taskId: "task-1", title: "Replay task", taskClass: "standard" as const, graph: replayGraph,
        completionGateIds: [], presetSnapshotDigest: null }, { eventId: "event-create", workspaceRevision: 1, occurredAt: "2026-08-11T00:00:00.000Z" });
      const proof = { taskIdUnique: true as const, actorBinding: actor };
      await assert.rejects(interrupted.execute(create, proof), new RegExp(`killpoint:${point}`, "u"));
      const commitCount = git(rootDir, "rev-list", "--count", "refs/ha/canonical").trim();
      const published = eventStore.readTaskEvent(create.opId);
      if (published === null) throw new Error(`${point} did not publish an event`);
      const eventBytes = serializeTaskEvent(published);
      const digest = `sha256:${createHash("sha256").update(eventBytes).digest("hex")}` as const;
      assert.equal(git(rootDir, "show", `refs/ha/canonical:harness/events/${create.opId}.json`), eventBytes);
      assert.equal(git(rootDir, "show", "refs/ha/canonical:harness/events/head.json"), serializeEventHead({ revision: 1, opId: create.opId, eventDigest: digest }));

      const resumed = makeTaskLifecycleService({ eventStore, projection });
      const first = await resumed.execute(create, proof);
      const second = await resumed.execute(create, proof);
      assert.equal(first.outcome, "applied", point);
      assert.deepEqual(second, first, point);
      assert.equal(projection.readOperation(create.opId)?.event.opId, create.opId);
      assert.equal(git(rootDir, "rev-list", "--count", "refs/ha/canonical").trim(), commitCount);
    } finally { rmSync(rootDir, { recursive: true, force: true }); }
  }
});

test("lease broker capacity ceiling rejects concurrent exhaustion and release restores availability", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-lease-capacity-"));
  try {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "test-repo", rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore, now: () => "2026-08-11T00:30:00.000Z" });
    const lease = (id: string) => ({ schema: "lease/v1" as const, taskId: `task-${id}`, executionId: `execution-${id}`, actor, source: "local" as const,
      phase: "reserving" as const, expiresAt: "2026-08-11T01:00:00.000Z", ttlMs: 1_800_000, version: 0 });
    for (let index = 0; index < TASK_LEASE_BROKER_CONTRACT.capacity; index += 1) {
      projection.reserveLease(lease(`cap-${index}`), "2026-08-11T00:00:00.000Z");
    }
    assert.throws(() => projection.reserveLease(lease("overflow"), "2026-08-11T00:00:00.000Z"), /capacity.*exhausted/iu);
    projection.releaseLease(projection.currentLease("task-cap-0")!);
    assert.equal(projection.reserveLease(lease("recovered"), "2026-08-11T00:00:00.000Z").taskId, "task-recovered");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
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
