// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AgentRuntimeEventV1 } from "../../src/domain/agent-runtime.ts";
import { terminalDomainStatuses } from "../../src/domain/lifecycle-status.ts";
import { taskEventTypes } from "../../src/domain/task-lifecycle-event.ts";
import { submissionDigest } from "../../src/domain/submission-digest.ts";
import {
  dispatchAdmissionBlocker,
  taskWriterConflict,
  dispatchAdmissionRefusal,
  dispatchLifecycleAddress,
  dispatchLifecycleTaskEventTypes,
  dispatchLifecycleTaskId,
  isDispatchLifecycleInput,
  taskLeaseAfter,
  type DispatchLifecycleInput,
  type DispatchTaskLease,
  dispatchLifecycleView,
  dispatchLifecycleSummary,
  dispatchOwnerForNode,
  reduceDispatchLifecycle,
  type DispatchLifecycleGroup,
  type DispatchLifecycleStep,
} from "../../src/domain/dispatch-lifecycle.ts";

type Token = {
  readonly t: "R" | "S" | "L" | "C" | "X" | "O";
  readonly liveness?: string;
  readonly outcome?: string;
  readonly exitCode?: number | null;
  readonly classification?: string;
  readonly fallbackState?: string;
  readonly reasonCode?: string;
};
interface LedgerShapes {
  readonly groups: readonly { readonly count: number; readonly sessions: readonly (readonly Token[])[] }[];
  readonly undispatched: readonly { readonly count: number; readonly sessions: readonly (readonly Token[])[] }[];
}
const shapes = JSON.parse(
  readFileSync(new URL("../fixtures/dispatch-lifecycle-ledger-shapes.json", import.meta.url), "utf8"),
) as LedgerShapes;

const types = {
  R: "runtime_dispatch_requested",
  S: "runtime_session_started",
  L: "runtime_session_liveness_changed",
  C: "runtime_session_cancelled",
  X: "runtime_session_exited",
  O: "runtime_session_outcome_observed",
} as const;

let revision = 0;
function runtimeEvent(
  token: Token,
  ids: { readonly dispatchId: string; readonly runtimeSessionId: string; readonly attemptGroupId: string },
  options: {
    readonly instanceId?: string;
    readonly source?: AgentRuntimeEventV1["source"];
    readonly dispatch?: Record<string, unknown>;
    readonly launchGeneration?: number;
    readonly eventId?: string;
    readonly resetAt?: string;
  } = {},
): AgentRuntimeEventV1 {
  revision += 1;
  const payload: Record<string, unknown> = { runtimeSessionId: ids.runtimeSessionId };
  if (token.t === "R")
    Object.assign(payload, {
      dispatchId: ids.dispatchId,
      instanceId: options.instanceId ?? "instance-a",
      kindId: "codex",
      ...(ids.attemptGroupId === ids.dispatchId ? {} : { attemptGroupId: ids.attemptGroupId }),
      ...options.dispatch,
    });
  if (token.t === "S") payload.launchGeneration = options.launchGeneration ?? 1;
  if (token.t === "L") payload.liveness = token.liveness;
  if (token.t === "O") {
    payload.outcome = token.outcome;
    if ("exitCode" in token) payload.exitCode = token.exitCode;
    if (token.reasonCode) payload.reasonCode = token.reasonCode;
    if (token.classification || token.fallbackState)
      payload.attempt = {
        classification: token.classification ?? "worker_stop",
        reason: "fixture",
        ...(token.fallbackState ? { fallbackState: token.fallbackState } : {}),
        ...(options.resetAt ? { resetAt: options.resetAt } : {}),
      };
  }
  return {
    schema: "agent-runtime-event/v1",
    eventId: options.eventId ?? `event-${revision}`,
    workspaceRevision: revision,
    opId: `op-${revision}`,
    type: types[token.t],
    actor: { principal: { personId: "owner" }, executor: null },
    source: options.source ?? "local",
    occurredAt: "2026-11-08T00:00:00.000Z",
    payload,
  } as unknown as AgentRuntimeEventV1;
}

/** A minimal store: the same address resolution and lease bookkeeping the projections perform. */
function fold(inputs: readonly (AgentRuntimeEventV1 | DispatchLifecycleInput)[]) {
  const events = inputs.filter(isDispatchLifecycleInput) as DispatchLifecycleInput[];
  const groups = new Map<string, DispatchLifecycleGroup>(),
    groupBySession = new Map<string, string>(),
    leases = new Map<string, DispatchTaskLease>(),
    steps: DispatchLifecycleStep[] = [];
  for (const event of events) {
    const taskId = dispatchLifecycleTaskId(event),
      context = { taskLease: taskId === null ? null : (leases.get(taskId) ?? null) },
      address = dispatchLifecycleAddress(event, context);
    const groupIds =
      address === null
        ? []
        : address.by === "group"
          ? [address.attemptGroupId]
          : address.by === "session"
            ? [groupBySession.get(address.runtimeSessionId)]
            : address.by === "task"
              ? [...groups.values()]
                  .filter(
                    (group) =>
                      group.phase !== "closed" &&
                      group.attempts.find(({ dispatchId }) => dispatchId === group.currentDispatchId)!.task?.taskId ===
                        address.taskId,
                  )
                  .map(({ attemptGroupId }) => attemptGroupId)
              : [...groups.values()]
                  .filter(
                    (group) =>
                      group.phase !== "closed" &&
                      address.executionIds.includes(
                        group.attempts.find(({ dispatchId }) => dispatchId === group.currentDispatchId)!.task
                          ?.executionId ?? "",
                      ),
                  )
                  .map(({ attemptGroupId }) => attemptGroupId);
    for (const groupId of groupIds) {
      const step = reduceDispatchLifecycle(
        groupId === undefined ? null : (groups.get(groupId) ?? null),
        event,
        context,
      );
      steps.push(step);
      if (step.kind !== "applied") continue;
      groups.set(step.group.attemptGroupId, step.group);
      for (const attempt of step.group.attempts)
        groupBySession.set(attempt.runtimeSessionId, step.group.attemptGroupId);
    }
    const lease = taskLeaseAfter(event);
    if (lease === null && taskId !== null) leases.delete(taskId);
    else if (lease && taskId !== null) leases.set(taskId, lease);
  }
  return { groups, steps };
}

function shapeEvents(sessions: readonly (readonly Token[])[], groupId: string): AgentRuntimeEventV1[] {
  return sessions.flatMap((tokens, index) => {
    const dispatchId = index === 0 ? groupId : `${groupId}-successor-${index}`;
    return tokens.map((token) =>
      runtimeEvent(token, { dispatchId, runtimeSessionId: `session-${dispatchId}`, attemptGroupId: groupId }),
    );
  });
}

const expectedPhase = (sessions: readonly (readonly Token[])[]) => {
  const last = sessions.at(-1)!.at(-1)!;
  if (last.t !== "O") return last.t === "R" ? "starting" : last.t === "S" || last.t === "L" ? "running" : "settling";
  if (last.fallbackState === "scheduled") return "waiting_backoff";
  if (last.classification === "awaiting_ruling") return "awaiting_ruling";
  return "closed";
};

test("every historical ledger group shape folds to its lifecycle phase with every attempt tracked", () => {
  const phases: Record<string, number> = {};
  shapes.groups.forEach(({ count, sessions }, index) => {
    const groupId = `group-${index}`,
      { groups, steps } = fold(shapeEvents(sessions, groupId)),
      group = groups.get(groupId);
    assert.ok(group, `shape ${index} produced no group`);
    assert.deepEqual(
      steps.filter((step) => step.kind === "rejected"),
      [],
      `shape ${index} must be interpretable without rejection`,
    );
    assert.equal(group.attempts.length, sessions.length, `shape ${index} must track every attempt`);
    assert.equal(group.phase, expectedPhase(sessions), `shape ${index}`);
    phases[group.phase] = (phases[group.phase] ?? 0) + count;
  });
  // The read-only ledger census of 2026-11-08: omitting an unclosed group kind fails here.
  assert.deepEqual(phases, { closed: 11439, waiting_backoff: 79, awaiting_ruling: 117, running: 14 });
});

test("historical sessions no dispatch admitted are not dispatches", () => {
  for (const [index, { sessions }] of shapes.undispatched.entries()) {
    const events = sessions[0]!.map((token) =>
        runtimeEvent(token, { dispatchId: `u-${index}`, runtimeSessionId: `u-${index}`, attemptGroupId: `u-${index}` }),
      ),
      { groups, steps } = fold(events);
    assert.equal(groups.size, 0);
    assert.ok(steps.every((step) => step.kind === "ignored"));
  }
});

test("admission → starting → running → closed releases the slot only after the stop is observed", () => {
  const ids = { dispatchId: "d-1", runtimeSessionId: "s-1", attemptGroupId: "d-1" },
    events = [runtimeEvent({ t: "R" }, ids)];
  const disposition = () => dispatchLifecycleView(fold(events).groups.get("d-1")!).policy.capacityDisposition;
  assert.equal(fold(events).groups.get("d-1")!.phase, "starting");
  assert.equal(disposition(), "busy");
  events.push(runtimeEvent({ t: "S" }, ids));
  assert.equal(fold(events).groups.get("d-1")!.phase, "running");
  events.push(runtimeEvent({ t: "C" }, ids));
  assert.equal(fold(events).groups.get("d-1")!.phase, "settling");
  assert.equal(disposition(), "busy", "a cancel request alone must not release the provider slot");
  events.push(runtimeEvent({ t: "X" }, ids));
  assert.equal(disposition(), "free");
  events.push(runtimeEvent({ t: "O", outcome: "cancelled", classification: "worker_stop" }, ids));
  const view = dispatchLifecycleView(fold(events).groups.get("d-1")!);
  assert.deepEqual([view.groupPhase, view.attempt.outcome, view.policy.groupSettled], ["closed", "cancelled", true]);
});

test("an unobservable process never releases its slot and blocks only its owner's admission on that instance", () => {
  const ids = { dispatchId: "d-2", runtimeSessionId: "s-2", attemptGroupId: "d-2" },
    node = { kind: "node", nodeId: "node-a" } as const,
    events = [
      runtimeEvent({ t: "R" }, ids, { source: node }),
      runtimeEvent({ t: "S" }, ids, { source: node }),
      runtimeEvent({ t: "L", liveness: "unknown" }, ids, { source: node }),
    ],
    views = [...fold(events).groups.values()].map((group) => dispatchLifecycleView(group));
  assert.equal(views[0]!.policy.capacityDisposition, "recovering");
  assert.equal(
    dispatchAdmissionBlocker(views, { instanceId: "instance-a", owner: dispatchOwnerForNode("node-a") })?.code,
    "runtime_recovery_pending",
  );
  assert.equal(
    dispatchAdmissionBlocker(views, { instanceId: "instance-a", owner: dispatchOwnerForNode("node-b") }),
    null,
  );
  assert.equal(
    dispatchAdmissionBlocker(views, { instanceId: "instance-a", owner: dispatchOwnerForNode(undefined) }),
    null,
  );
  assert.equal(
    dispatchAdmissionBlocker(views, { instanceId: "instance-b", owner: dispatchOwnerForNode("node-a") }),
    null,
  );
  events.push(runtimeEvent({ t: "L", liveness: "live" }, ids, { source: node }));
  const live = [...fold(events).groups.values()].map((group) => dispatchLifecycleView(group));
  assert.equal(
    dispatchAdmissionBlocker(live, { instanceId: "instance-a", owner: dispatchOwnerForNode("node-a") }),
    null,
  );
});

test("instance capacity counts unreleased reservations across groups and owners, without serializing spare slots", () => {
  const first = { dispatchId: "capacity-1", runtimeSessionId: "capacity-s1", attemptGroupId: "capacity-g1" },
    second = { dispatchId: "capacity-2", runtimeSessionId: "capacity-s2", attemptGroupId: "capacity-g2" },
    events = [runtimeEvent({ t: "R" }, first), runtimeEvent({ t: "S" }, first)],
    admit = (capacity: number, owner = "local") =>
      dispatchAdmissionRefusal({
        group: null,
        instance: [...fold(events).groups.values()].map((g) => dispatchLifecycleView(g)),
        instanceId: "instance-a",
        owner,
        capacity,
      });
  assert.equal(admit(1)?.code, "runtime_capacity_exhausted");
  assert.equal(admit(1, "node:another-node")?.code, "runtime_capacity_exhausted");
  assert.equal(admit(2), null);
  events.push(runtimeEvent({ t: "R" }, second));
  assert.equal(admit(2)?.code, "runtime_capacity_exhausted", "starting reservations count too");
  events.push(runtimeEvent({ t: "C" }, first));
  assert.equal(admit(2)?.code, "runtime_capacity_exhausted", "cancel intent is not stop proof");
  events.push(runtimeEvent({ t: "X" }, first));
  assert.equal(admit(2), null, "accepted stop frees a slot while its group is still settling");
  assert.equal(admit(1)?.code, "runtime_capacity_exhausted");
  events.push(runtimeEvent({ t: "X" }, second));
  assert.equal(admit(1), null);
  assert.throws(() => admit(0), /capacity must be a positive integer/u);
});

test("illegal transitions, late events and superseded attempts are rejected", () => {
  const first = { dispatchId: "g-3", runtimeSessionId: "s-3a", attemptGroupId: "g-3" },
    second = { dispatchId: "g-3-b", runtimeSessionId: "s-3b", attemptGroupId: "g-3" },
    events = [
      runtimeEvent({ t: "R" }, first),
      runtimeEvent({ t: "S" }, first),
      runtimeEvent({ t: "X" }, first),
      runtimeEvent({ t: "S" }, first),
    ];
  assert.deepEqual(fold(events).steps.at(-1), {
    kind: "rejected",
    code: "dispatch_transition_illegal",
    reason: "runtime_session_started is not legal while dispatch g-3 is settling.",
  });
  events.push(
    runtimeEvent({ t: "O", outcome: "failed", classification: "provider_fault", fallbackState: "scheduled" }, first),
  );
  events.push(runtimeEvent({ t: "L", liveness: "live" }, first));
  assert.equal((fold(events).steps.at(-1) as { code?: string }).code, "dispatch_attempt_closed");
  events.push(runtimeEvent({ t: "R" }, second));
  const { groups } = fold(events);
  assert.equal(groups.get("g-3")!.currentDispatchId, "g-3-b");
  assert.equal(groups.get("g-3")!.phase, "starting");
});

test("a replayed event is accepted once and a concurrent admission into a busy group loses", () => {
  const ids = { dispatchId: "d-4", runtimeSessionId: "s-4", attemptGroupId: "d-4" },
    admitted = runtimeEvent({ t: "R" }, ids),
    started = runtimeEvent({ t: "S" }, ids),
    once = fold([admitted, started]).groups.get("d-4")!,
    twice = fold([admitted, started, started, admitted]);
  assert.deepEqual(twice.groups.get("d-4"), once);
  assert.deepEqual(
    twice.steps.slice(2).map(({ kind }) => kind),
    ["ignored", "ignored"],
  );
  const rival = runtimeEvent(
      { t: "R" },
      { dispatchId: "d-4-rival", runtimeSessionId: "s-4-rival", attemptGroupId: "d-4" },
    ),
    raced = fold([admitted, started, rival]);
  assert.equal((raced.steps.at(-1) as { code?: string }).code, "dispatch_group_busy");
  assert.deepEqual(raced.groups.get("d-4"), fold([admitted, started]).groups.get("d-4"));
});

test("a waiting fallback admits its successor and an awaiting ruling holds no slot", () => {
  const backoff = { dispatchId: "d-5", runtimeSessionId: "s-5", attemptGroupId: "d-5" },
    ruling = { dispatchId: "d-6", runtimeSessionId: "s-6", attemptGroupId: "d-6" },
    events = [
      ...[{ t: "R" }, { t: "S" }, { t: "X" }].map((token) => runtimeEvent(token as Token, backoff)),
      runtimeEvent(
        { t: "O", outcome: "failed", classification: "provider_quota", fallbackState: "scheduled" },
        backoff,
      ),
      ...[{ t: "R" }, { t: "S" }, { t: "X" }].map((token) => runtimeEvent(token as Token, ruling)),
      runtimeEvent({ t: "O", outcome: "stopped", classification: "awaiting_ruling" }, ruling),
    ],
    folded = fold(events),
    views = [...folded.groups.values()].map((group) => dispatchLifecycleView(group));
  assert.deepEqual(
    views.map(({ groupPhase, policy }) => [groupPhase, policy.capacityDisposition]),
    [
      ["waiting_backoff", "free"],
      ["awaiting_ruling", "free"],
    ],
  );
  assert.equal(dispatchAdmissionBlocker(views, { instanceId: "instance-a", owner: "local" }), null);
  events.push(
    runtimeEvent({ t: "R" }, { dispatchId: "d-5-next", runtimeSessionId: "s-5-next", attemptGroupId: "d-5" }),
  );
  assert.equal(fold(events).groups.get("d-5")!.currentDispatchId, "d-5-next");
});

let taskRevisionOffset = 0;
function taskEvent(type: string, taskId: string, payload: Record<string, unknown>): DispatchLifecycleInput {
  revision += 1;
  taskRevisionOffset += 1;
  return {
    schema: "task-event/v1",
    eventId: `task-event-${taskRevisionOffset}`,
    workspaceRevision: revision,
    opId: `task-op-${taskRevisionOffset}`,
    type,
    taskId,
    actor: { principal: { personId: "owner" }, executor: null },
    source: "local",
    occurredAt: "2026-11-08T00:00:00.000Z",
    payload: { documentClaims: [], ...payload },
  } as unknown as DispatchLifecycleInput;
}
const execution = (executionId: string, submission: unknown = null) => ({ executionId, submission });
const implementer = (taskId: string, executionId: string) => ({
  dispatch: { taskId, executionId, role: "implementer", cwd: `/worktrees/${taskId}` },
});

test("an admitted attempt carries its owner fence, capacity reservation, task lease and workspace", () => {
  const ids = { dispatchId: "d-auth", runtimeSessionId: "s-auth", attemptGroupId: "d-auth" },
    node = { kind: "node", nodeId: "node-a" } as const,
    events: DispatchLifecycleInput[] = [
      taskEvent("execution_started", "task-a", { execution: execution("exe-a"), lease: { version: 3 } }),
      runtimeEvent({ t: "R" }, ids, { source: node, ...implementer("task-a", "exe-a") }) as DispatchLifecycleInput,
    ],
    admittedAt = revision;
  events.push(runtimeEvent({ t: "S" }, ids, { source: node, launchGeneration: 2 }) as DispatchLifecycleInput);
  const view = dispatchLifecycleView(fold(events).groups.get("d-auth")!);
  assert.deepEqual(view.attempt.fence, { owner: "node:node-a", verified: true, token: admittedAt, epoch: 2 });
  assert.deepEqual(view.attempt.reservation, {
    reservationId: "instance-a/d-auth",
    instanceId: "instance-a",
    owner: "node:node-a",
  });
  assert.deepEqual(view.attempt.task, {
    taskId: "task-a",
    executionId: "exe-a",
    role: "implementer",
    leaseVersion: 3,
    leaseReleased: false,
    reviewTargetDigest: null,
  });
  assert.equal(view.attempt.workspaceRef, "/worktrees/task-a");
  assert.equal(view.policy.capacity, "held");
});

test("events from another owner, a stale launch epoch, or a redelivered event id cannot advance an attempt", () => {
  const ids = { dispatchId: "d-fence", runtimeSessionId: "s-fence", attemptGroupId: "d-fence" },
    node = { kind: "node", nodeId: "node-a" } as const,
    events = [
      runtimeEvent({ t: "R" }, ids, { source: node }),
      runtimeEvent({ t: "S" }, ids, { source: node, launchGeneration: 2 }),
      runtimeEvent({ t: "X" }, ids, { source: { kind: "node", nodeId: "node-b" } }),
    ];
  assert.equal((fold(events).steps.at(-1) as { code?: string }).code, "dispatch_owner_fence_mismatch");
  events.push(runtimeEvent({ t: "X" }, ids, { source: "local" }));
  assert.equal((fold(events).steps.at(-1) as { code?: string }).code, "dispatch_owner_fence_mismatch");
  events.push(runtimeEvent({ t: "S" }, ids, { source: node, launchGeneration: 1 }));
  assert.equal((fold(events).steps.at(-1) as { code?: string }).code, "dispatch_epoch_stale");
  const before = fold(events).groups.get("d-fence")!;
  events.push(runtimeEvent({ t: "X" }, ids, { source: node, eventId: before.attempts[0]!.eventIds[1]! }));
  assert.equal(fold(events).steps.at(-1)!.kind, "ignored", "an event id is accepted once whatever its revision");
  assert.equal(fold(events).groups.get("d-fence")!.attempts[0]!.phase, "running");
  events.push(runtimeEvent({ t: "X" }, ids, { source: node }));
  assert.equal(dispatchLifecycleView(fold(events).groups.get("d-fence")!).policy.capacity, "released");
});

test("an owner the center cannot verify is imported as settling and keeps its reservation and lease (F1)", () => {
  const ids = { dispatchId: "d-unv", runtimeSessionId: "s-unv", attemptGroupId: "d-unv" },
    events: DispatchLifecycleInput[] = [
      taskEvent("execution_started", "task-u", { execution: execution("exe-u"), lease: { version: 7 } }),
      runtimeEvent({ t: "R" }, ids, {
        source: "migration-import/v1",
        ...implementer("task-u", "exe-u"),
      }) as DispatchLifecycleInput,
    ];
  let view = dispatchLifecycleView(fold(events).groups.get("d-unv")!);
  assert.deepEqual(
    [view.groupPhase, view.attempt.phase, view.attempt.fence.verified, view.policy.capacity],
    ["settling", "settling", false, "held"],
  );
  assert.equal(view.attempt.task?.leaseVersion, 7, "the original task lease is preserved");
  assert.deepEqual(
    [view.policy.capacityDisposition, view.policy.canRecover, view.policy.canResolveRuling, view.policy.blockerCode],
    ["recovering", false, false, "dispatch_owner_unverified"],
  );
  for (const owner of ["local", "node:node-a"])
    assert.equal(
      dispatchAdmissionBlocker([view], { instanceId: "instance-a", owner })?.code,
      "dispatch_owner_unverified",
      `admission by ${owner} fails closed`,
    );
  for (const token of [{ t: "X" }, { t: "O", outcome: "stopped", classification: "awaiting_ruling" }] as Token[]) {
    events.push(runtimeEvent(token, ids, { source: "local" }) as DispatchLifecycleInput);
    assert.equal((fold(events).steps.at(-1) as { code?: string }).code, "dispatch_owner_unverified");
  }
  events.push(taskEvent("lease_released", "task-u", { execution: execution("exe-u"), releasedLease: { version: 7 } }));
  view = dispatchLifecycleView(fold(events).groups.get("d-unv")!);
  assert.deepEqual(
    [view.groupPhase, view.policy.capacity, view.policy.canResolveRuling, view.policy.canRecover],
    ["settling", "held", false, false],
    "a lease release alone neither releases capacity nor exposes a resolvable ruling",
  );
});

test("a pending ruling becomes awaiting_ruling only after the stop is proven and the matching lease released", () => {
  const ids = { dispatchId: "d-rule", runtimeSessionId: "s-rule", attemptGroupId: "d-rule" },
    events: DispatchLifecycleInput[] = [
      taskEvent("execution_started", "task-r", { execution: execution("exe-r"), lease: { version: 1 } }),
      ...([{ t: "R" }, { t: "S" }, { t: "X" }] as Token[]).map(
        (token) => runtimeEvent(token, ids, implementer("task-r", "exe-r")) as DispatchLifecycleInput,
      ),
      runtimeEvent({ t: "O", outcome: "stopped", classification: "awaiting_ruling" }, ids) as DispatchLifecycleInput,
    ];
  let view = dispatchLifecycleView(fold(events).groups.get("d-rule")!);
  assert.deepEqual(
    [view.groupPhase, view.ruling, view.policy.canResolveRuling],
    ["settling", { dispatchId: "d-rule", status: "awaiting" }, false],
  );
  events.push(taskEvent("lease_renewed", "task-r", { execution: execution("exe-r"), lease: { version: 2 } }));
  assert.equal(fold(events).groups.get("d-rule")!.attempts[0]!.task?.leaseVersion, 2);
  events.push(taskEvent("lease_released", "task-r", { execution: execution("exe-r"), releasedLease: { version: 2 } }));
  view = dispatchLifecycleView(fold(events).groups.get("d-rule")!);
  assert.deepEqual(
    [view.groupPhase, view.policy.capacity, view.policy.canResolveRuling],
    ["awaiting_ruling", "released", true],
  );
});

test("a stopped attempt retains its released lease generation after the task restarts", () => {
  const ids = { dispatchId: "d-old-lease", runtimeSessionId: "s-old-lease", attemptGroupId: "d-old-lease" },
    events: DispatchLifecycleInput[] = [
      taskEvent("execution_started", "task-old-lease", {
        execution: execution("exe-old-lease"),
        lease: { version: 1 },
      }),
      runtimeEvent({ t: "R" }, ids, {
        dispatch: {
          taskId: "task-old-lease",
          executionId: "exe-old-lease",
          role: "implementer",
        },
      }) as DispatchLifecycleInput,
      runtimeEvent({ t: "S" }, ids),
      runtimeEvent({ t: "X" }, ids),
      taskEvent("lease_released", "task-old-lease", {
        execution: execution("exe-old-lease"),
        releasedLease: { version: 1 },
      }),
      taskEvent("execution_started", "task-old-lease", {
        execution: execution("exe-old-lease"),
        lease: { version: 2 },
      }),
      runtimeEvent({ t: "O", outcome: "succeeded" }, ids),
    ],
    view = dispatchLifecycleView(fold(events).groups.get(ids.attemptGroupId)!);
  assert.deepEqual(
    [view.attempt.task?.leaseVersion, view.attempt.task?.leaseReleased, view.policy.canRecover],
    [1, true, false],
  );
});

test("an attempt never acquires a replacement lease generation after releasing its own", () => {
  const ids = { dispatchId: "d-rejoin", runtimeSessionId: "s-rejoin", attemptGroupId: "d-rejoin" },
    events: DispatchLifecycleInput[] = [
      taskEvent("execution_started", "task-r", { execution: execution("exe-r"), lease: { version: 1 } }),
      ...([{ t: "R" }, { t: "S" }] as Token[]).map(
        (token) => runtimeEvent(token, ids, implementer("task-r", "exe-r")) as DispatchLifecycleInput,
      ),
      taskEvent("lease_released", "task-r", { execution: execution("exe-r"), releasedLease: { version: 1 } }),
    ];
  for (const [type, version] of [
    ["execution_started", 2],
    ["lease_renewed", 3],
  ] as const) {
    events.push(taskEvent(type, "task-r", { execution: execution("exe-r"), lease: { version } }));
    const view = dispatchLifecycleView(fold(events).groups.get(ids.attemptGroupId)!);
    assert.equal(view.attempt.task?.leaseVersion, 1);
    assert.equal(view.attempt.task?.leaseReleased, true);
    assert.equal(view.policy.capacity, "held", "lease handoff does not prove the runtime stopped");
  }
});

test("an explicit owner abandonment closes an unreachable attempt without manufacturing stop proof", () => {
  const ids = { dispatchId: "d-abandon", runtimeSessionId: "s-abandon", attemptGroupId: "d-abandon" },
    events = (
      [{ t: "R" }, { t: "S" }, { t: "O", outcome: "unknown", reasonCode: "ruling_resolved", exitCode: null }] as Token[]
    ).map((token) => runtimeEvent(token, ids) as DispatchLifecycleInput),
    view = dispatchLifecycleView(fold(events).groups.get(ids.attemptGroupId)!);
  assert.equal(view.groupPhase, "closed");
  assert.equal(view.attempt.outcome, "unknown");
  assert.equal(view.attempt.stopProof, "unproven");
  assert.equal(view.policy.groupSettled, true);
  assert.equal(view.policy.capacity, "released");
});

test("ruling resolution closes the group and admits its next attempt", () => {
  const ids = { dispatchId: "d-resolve", runtimeSessionId: "s-resolve", attemptGroupId: "d-resolve" },
    events: DispatchLifecycleInput[] = [
      taskEvent("execution_started", "task-resolve", { execution: execution("exe-resolve"), lease: { version: 1 } }),
      ...([{ t: "R" }, { t: "S" }, { t: "X" }] as Token[]).map(
        (token) => runtimeEvent(token, ids, implementer("task-resolve", "exe-resolve")) as DispatchLifecycleInput,
      ),
      runtimeEvent({ t: "O", outcome: "stopped", classification: "awaiting_ruling" }, ids) as DispatchLifecycleInput,
      taskEvent("lease_released", "task-resolve", {
        execution: execution("exe-resolve"),
        releasedLease: { version: 1 },
      }),
    ];
  let view = dispatchLifecycleView(fold(events).groups.get(ids.attemptGroupId)!);
  assert.equal(view.groupPhase, "awaiting_ruling");
  events.push(
    runtimeEvent({ t: "O", outcome: "unknown", reasonCode: "ruling_resolved" }, ids) as DispatchLifecycleInput,
  );
  view = dispatchLifecycleView(fold(events).groups.get(ids.attemptGroupId)!);
  assert.deepEqual(
    [view.groupPhase, view.ruling, view.successor.admissible, view.policy.canResolveRuling],
    ["closed", null, true, false],
  );
  events.push(
    runtimeEvent(
      { t: "R" },
      { ...ids, dispatchId: "d-resolve-next", runtimeSessionId: "s-resolve-next" },
    ) as DispatchLifecycleInput,
  );
  const folded = fold(events),
    next = folded.groups.get(ids.attemptGroupId)!;
  assert.equal(folded.steps.at(-1)?.kind, "applied");
  assert.equal(next.currentDispatchId, "d-resolve-next");
  assert.equal(next.phase, "starting");
});

test("a scheduled fallback carries its due time and a delivery is registered against its target", () => {
  const backoff = { dispatchId: "d-due", runtimeSessionId: "s-due", attemptGroupId: "d-due" },
    review = { dispatchId: "d-rev", runtimeSessionId: "s-rev", attemptGroupId: "d-rev" },
    submission = { commit: "abc" },
    digest = submissionDigest(submission as never),
    events: DispatchLifecycleInput[] = [
      ...([{ t: "R" }, { t: "S" }, { t: "X" }] as Token[]).map(
        (token) => runtimeEvent(token, backoff, implementer("task-d", "exe-d")) as DispatchLifecycleInput,
      ),
      runtimeEvent(
        { t: "O", outcome: "failed", classification: "provider_quota", fallbackState: "scheduled" },
        backoff,
        { resetAt: "2026-11-08T01:00:00.000Z" },
      ) as DispatchLifecycleInput,
      taskEvent("execution_submitted", "task-d", { execution: execution("exe-d", submission) }),
      runtimeEvent({ t: "R" }, review, {
        dispatch: { taskId: "task-d", executionId: "exe-d", role: "reviewer", reviewTarget: { kind: "task", digest } },
      }) as DispatchLifecycleInput,
      runtimeEvent({ t: "S" }, review) as DispatchLifecycleInput,
      taskEvent("review_recorded", "task-d", {
        execution: execution("exe-d", submission),
        review: { reviewId: "review-d-rev", executionId: "exe-d", submissionDigest: digest },
      }),
    ],
    folded = fold(events),
    waiting = dispatchLifecycleView(folded.groups.get("d-due")!),
    reviewed = dispatchLifecycleView(folded.groups.get("d-rev")!);
  assert.deepEqual(waiting.successor, { admissible: true, dueAt: "2026-11-08T01:00:00.000Z" });
  assert.deepEqual(
    [waiting.delivery.status, waiting.delivery.targetRef, waiting.delivery.targetDigest],
    ["registered", "execution:exe-d", digest],
  );
  assert.deepEqual(
    [reviewed.delivery.status, reviewed.delivery.targetRef, reviewed.groupPhase],
    ["registered", "review:review-d-rev", "running"],
    "a registered review is a delivery; the reviewer still runs until it stops",
  );
  assert.equal(reviewed.policy.consentBlocked, true, "review registration alone does not finish the review lane");
  assert.deepEqual(
    [reviewed.attempt.stopProof, reviewed.policy.capacityDisposition],
    ["unproven", "busy"],
    "delivery registration does not release capacity while the review process is still running",
  );
});

test("the center writer refuses a second admission into a busy group and a successor from another owner", () => {
  const ids = { dispatchId: "d-w", runtimeSessionId: "s-w", attemptGroupId: "d-w" },
    events = [runtimeEvent({ t: "R" }, ids), runtimeEvent({ t: "S" }, ids)];
  const busy = dispatchLifecycleView(fold(events).groups.get("d-w")!);
  assert.equal(
    dispatchAdmissionRefusal({ group: busy, instance: [busy], instanceId: "instance-a", owner: "local" })?.code,
    "dispatch_group_busy",
  );
  events.push(
    runtimeEvent({ t: "X" }, ids),
    runtimeEvent({ t: "O", outcome: "failed", classification: "provider_fault", fallbackState: "scheduled" }, ids),
  );
  const waiting = dispatchLifecycleView(fold(events).groups.get("d-w")!);
  assert.equal(
    dispatchAdmissionRefusal({ group: waiting, instance: [], instanceId: "instance-a", owner: "node:node-a" })?.code,
    "dispatch_owner_fence_mismatch",
  );
  assert.equal(
    dispatchAdmissionRefusal({ group: waiting, instance: [], instanceId: "instance-a", owner: "local" }),
    null,
  );
  events.push(
    runtimeEvent(
      { t: "R" },
      { dispatchId: "d-w-node", runtimeSessionId: "s-w-node", attemptGroupId: "d-w" },
      { source: { kind: "node", nodeId: "node-a" } },
    ),
  );
  assert.equal((fold(events).steps.at(-1) as { code?: string }).code, "dispatch_owner_fence_mismatch");
});

test("fallback schedule uses its own due time and closes the group on launch exhaustion", () => {
  const ids = {
    dispatchId: "dispatch-schedule",
    runtimeSessionId: "runtime-schedule",
    attemptGroupId: "dispatch-schedule",
  };
  const requested = runtimeEvent({ t: "R" }, ids),
    exited = runtimeEvent({ t: "X" }, ids),
    outcome = runtimeEvent(
      { t: "O", outcome: "failed", classification: "provider_fault", fallbackState: "scheduled" },
      ids,
      { resetAt: "2026-11-08T00:00:10.000Z" },
    );
  assert.ok(outcome.type === "runtime_session_outcome_observed" && outcome.payload.attempt);
  const schedule = {
    notBeforeAt: "2026-11-08T00:01:00.000Z",
    nextProvider: { instance: "instance-b", model: "model-b" },
  };
  const scheduled = {
    ...outcome,
    payload: { ...outcome.payload, attempt: { ...outcome.payload.attempt, fallbackSchedule: schedule } },
  };
  let group: DispatchLifecycleGroup | null = null;
  for (const event of [requested, exited, scheduled]) {
    const step = reduceDispatchLifecycle(group, event);
    assert.equal(step.kind, "applied");
    if (step.kind === "applied") group = step.group;
  }
  const waiting = dispatchLifecycleView(group!);
  assert.equal(waiting.groupPhase, "waiting_backoff");
  assert.equal(waiting.policy.groupSettled, false);
  assert.equal(waiting.successor.dueAt, schedule.notBeforeAt);
  assert.equal(
    dispatchAdmissionRefusal({
      group: waiting,
      instance: [],
      instanceId: "instance-b",
      owner: "local",
      now: "2026-11-08T00:00:20.000Z",
    })?.code,
    "dispatch_fallback_not_due",
  );
  assert.equal(
    dispatchAdmissionRefusal({
      group: waiting,
      instance: [],
      instanceId: "instance-c",
      owner: "local",
      now: schedule.notBeforeAt,
    })?.code,
    "dispatch_fallback_candidate_mismatch",
  );
  const exhausted = {
    ...outcome,
    eventId: "exhausted-event",
    workspaceRevision: ++revision,
    payload: { ...outcome.payload, attempt: { ...outcome.payload.attempt, fallbackState: "exhausted" as const } },
  };
  const step = reduceDispatchLifecycle(group, exhausted);
  assert.equal(step.kind, "applied");
  if (step.kind !== "applied") return;
  assert.equal(step.group.phase, "closed");
  assert.equal(step.group.attempts[0]?.outcome, "failed");
  assert.equal(dispatchLifecycleView(step.group).policy.groupSettled, true);
  assert.equal(step.group.successor.admissible, false);
  assert.equal(reduceDispatchLifecycle(step.group, exhausted).kind, "ignored");
});

// The compatibility pointer names the adjacent attempt; the control leaf may be several attempts later.
test("lifecycle summary preserves each immediate successor in a three-attempt group", () => {
  const events = shapeEvents(
    [
      [
        { t: "R" },
        { t: "S" },
        { t: "O", outcome: "failed", classification: "provider_fault", fallbackState: "scheduled" },
      ],
      [
        { t: "R" },
        { t: "S" },
        { t: "O", outcome: "failed", classification: "provider_fault", fallbackState: "scheduled" },
      ],
      [{ t: "R" }, { t: "S" }, { t: "O", outcome: "stopped", classification: "worker_stop" }],
    ],
    "summary-chain",
  );
  const group = fold(events).groups.get("summary-chain")!;
  assert.equal(group.attempts.length, 3);
  assert.deepEqual(
    group.attempts.map(
      ({ dispatchId }) =>
        dispatchLifecycleSummary({
          status: "ready",
          watermark: group.revision,
          sourceRevision: group.revision,
          rows: [dispatchLifecycleView(group, dispatchId)],
          nextCursor: null,
        }).nextDispatchId,
    ),
    ["summary-chain-successor-1", "summary-chain-successor-2", null],
  );
});

// Anti-regression gate for Issue #4632: terminal task transitions and execution retirements/replacements
// must remain addressed in dispatchLifecycleTaskEventTypes and close stopped historical groups without
// breaking capacity or stopProof invariants on live/unproven attempts.
test("terminal task events and execution retirements close stopped non-running groups after lease release", () => {
  const requiredTaskEventTypes = [
    "execution_started",
    "task_completion_generation_retired",
    "task_completed",
    "task_transitioned",
    "task_superseded",
  ] as const;
  for (const type of requiredTaskEventTypes) {
    assert.ok(
      (taskEventTypes as readonly string[]).includes(type),
      `expected canonical task event type ${type} in taskEventTypes`,
    );
    assert.ok(
      (dispatchLifecycleTaskEventTypes as readonly string[]).includes(type),
      `dispatchLifecycleTaskEventTypes must include ${type}`,
    );
  }

  const baseTaskSnapshot = (taskId: string, status: string, extra: Record<string, unknown> = {}) => ({
    taskId,
    status,
    pinned: false,
    ...extra,
  });

  const closers = [
    {
      name: "task_completed with execution",
      event: (taskId: string, exeId: string) =>
        taskEvent("task_completed", taskId, {
          task: baseTaskSnapshot(taskId, "done"),
          execution: { ...execution(exeId), taskId, state: "accepted" },
        }),
    },
    {
      name: "task_completed without execution (siblingResolution)",
      event: (taskId: string) =>
        taskEvent("task_completed", taskId, {
          task: baseTaskSnapshot(taskId, "done"),
          siblingResolution: { sourceTaskId: "task-sibling", rationale: "merged", factRef: "fact:f1" },
        }),
    },
    ...terminalDomainStatuses.map((status) => ({
      name: `task_transitioned to terminal ${status}`,
      event: (taskId: string) =>
        taskEvent("task_transitioned", taskId, {
          task: baseTaskSnapshot(taskId, status),
          mutation: { command: "transition", reason: `transition to ${status}`, fields: ["status"] },
        }),
    })),
    {
      name: "task_superseded",
      event: (taskId: string) =>
        taskEvent("task_superseded", taskId, {
          task: baseTaskSnapshot(taskId, "cancelled", {
            packageDisposition: "archived",
            supersededBy: "task-successor",
          }),
          mutation: { command: "supersede", reason: "superseded", fields: ["status", "supersededBy"] },
        }),
    },
    {
      name: "task_completion_generation_retired matching execution",
      event: (taskId: string, exeId: string) =>
        taskEvent("task_completion_generation_retired", taskId, {
          task: baseTaskSnapshot(taskId, "active"),
          execution: { ...execution(exeId), taskId, state: "abandoned" },
          sourceGeneration: 1,
        }),
    },
    {
      name: "new execution_started replacing historical execution",
      event: (taskId: string, exeId: string) =>
        taskEvent("execution_started", taskId, {
          execution: { ...execution(`${exeId}-next`), taskId, state: "running" },
          lease: { version: 1 },
        }),
    },
  ] as const;

  for (const state of ["awaiting_ruling", "waiting_backoff", "settling_after_outcome"] as const) {
    for (const [index, closer] of closers.entries()) {
      const taskId = `task-close-${state}-${index}`,
        exeId = `exe-close-${state}-${index}`,
        groupId = `g-close-${state}-${index}`,
        ids = {
          dispatchId: `d-close-${state}-${index}`,
          runtimeSessionId: `s-close-${state}-${index}`,
          attemptGroupId: groupId,
        },
        outcomeToken: Token =
          state === "waiting_backoff"
            ? { t: "O", outcome: "failed", classification: "provider_fault", fallbackState: "scheduled" }
            : { t: "O", outcome: "stopped", classification: "awaiting_ruling" };
      const events: DispatchLifecycleInput[] = [
        taskEvent("execution_started", taskId, { execution: execution(exeId), lease: { version: 1 } }),
        runtimeEvent({ t: "R" }, ids, implementer(taskId, exeId)) as DispatchLifecycleInput,
        runtimeEvent({ t: "S" }, ids),
        runtimeEvent({ t: "X" }, ids),
        runtimeEvent(outcomeToken, ids) as DispatchLifecycleInput,
      ];
      if (state !== "settling_after_outcome") {
        events.push(
          taskEvent("lease_released", taskId, { execution: execution(exeId), releasedLease: { version: 1 } }),
        );
      }
      const beforeGroup = fold(events).groups.get(groupId)!;
      assert.equal(
        beforeGroup.phase,
        state === "settling_after_outcome" ? "settling" : state,
        `precondition for ${state} (${closer.name})`,
      );

      events.push(closer.event(taskId, exeId));
      const afterGroup = fold(events).groups.get(groupId)!,
        view = dispatchLifecycleView(afterGroup);
      assert.deepEqual(
        [
          afterGroup.phase,
          afterGroup.ruling,
          afterGroup.successor,
          afterGroup.attempts[0]?.stopProof,
          view.policy.groupSettled,
          view.policy.consentBlocked,
          view.policy.fallbackPending,
          view.policy.canResolveRuling,
        ],
        ["closed", null, { admissible: false, dueAt: null }, "proven_stopped", true, false, false, false],
        `${state} must converge to closed on ${closer.name}`,
      );
    }
  }

  // Task-scoped dispatch with executionId: null must also close on terminal task events.
  const noExeIds = { dispatchId: "d-no-exe", runtimeSessionId: "s-no-exe", attemptGroupId: "g-no-exe" };
  const noExeEvents: DispatchLifecycleInput[] = [
    runtimeEvent({ t: "R" }, noExeIds, {
      dispatch: { taskId: "task-no-exe", role: "implementer" },
    }) as DispatchLifecycleInput,
    runtimeEvent({ t: "S" }, noExeIds),
    runtimeEvent({ t: "X" }, noExeIds),
    runtimeEvent({ t: "O", outcome: "stopped", classification: "awaiting_ruling" }, noExeIds) as DispatchLifecycleInput,
    taskEvent("task_transitioned", "task-no-exe", {
      task: baseTaskSnapshot("task-no-exe", "cancelled"),
      mutation: { command: "transition", reason: "cancelled", fields: ["status"] },
    }),
  ];
  assert.equal(fold(noExeEvents).groups.get("g-no-exe")!.phase, "closed");

  // Non-terminal task_transitioned must leave waiting_backoff / awaiting_ruling open.
  const nonTerminalIds = { dispatchId: "d-block", runtimeSessionId: "s-block", attemptGroupId: "g-block" };
  const nonTerminalEvents: DispatchLifecycleInput[] = [
    taskEvent("execution_started", "task-block", { execution: execution("exe-block"), lease: { version: 1 } }),
    runtimeEvent({ t: "R" }, nonTerminalIds, implementer("task-block", "exe-block")) as DispatchLifecycleInput,
    runtimeEvent({ t: "S" }, nonTerminalIds),
    runtimeEvent({ t: "X" }, nonTerminalIds),
    runtimeEvent(
      { t: "O", outcome: "stopped", classification: "awaiting_ruling" },
      nonTerminalIds,
    ) as DispatchLifecycleInput,
    taskEvent("lease_released", "task-block", { execution: execution("exe-block"), releasedLease: { version: 1 } }),
    taskEvent("task_transitioned", "task-block", {
      task: baseTaskSnapshot("task-block", "blocked"),
      mutation: { command: "transition", reason: "blocked", fields: ["status"] },
    }),
  ];
  assert.equal(fold(nonTerminalEvents).groups.get("g-block")!.phase, "awaiting_ruling");
  assert.equal(
    dispatchLifecycleAddress(nonTerminalEvents.at(-1)!, { taskLease: null }),
    null,
    "non-terminal task_transitioned without held lease requires zero group lookups",
  );
});

test("running, starting, and unproven settling attempts preserve stopProof and capacity across task events", () => {
  for (const activeKind of ["starting", "running", "settling_unproven"] as const) {
    const taskId = `task-live-${activeKind}`,
      exeId = `exe-live-${activeKind}`,
      groupId = `g-live-${activeKind}`,
      ids = { dispatchId: `d-live-${activeKind}`, runtimeSessionId: `s-live-${activeKind}`, attemptGroupId: groupId };
    const events: DispatchLifecycleInput[] = [
      taskEvent("execution_started", taskId, { execution: execution(exeId), lease: { version: 1 } }),
      runtimeEvent({ t: "R" }, ids, implementer(taskId, exeId)) as DispatchLifecycleInput,
    ];
    if (activeKind !== "starting") events.push(runtimeEvent({ t: "S" }, ids));
    if (activeKind === "settling_unproven") events.push(runtimeEvent({ t: "C" }, ids));
    events.push(
      taskEvent("lease_released", taskId, { execution: execution(exeId), releasedLease: { version: 1 } }),
      taskEvent("task_transitioned", taskId, {
        task: { taskId, status: "cancelled", pinned: false },
        mutation: { command: "transition", reason: "cancelled", fields: ["status"] },
      }),
      taskEvent("task_completed", taskId, {
        task: { taskId, status: "done", pinned: false },
        siblingResolution: { sourceTaskId: "sib", rationale: "done", factRef: "fact:f2" },
      }),
    );
    const group = fold(events).groups.get(groupId)!,
      view = dispatchLifecycleView(group),
      expectedPhase = activeKind === "settling_unproven" ? "settling" : activeKind;
    assert.equal(group.phase, expectedPhase, `${activeKind} must never close prematurely`);
    assert.equal(group.attempts[0]?.stopProof, "unproven", `${activeKind} must never forge stopProof`);
    assert.notEqual(view.policy.capacity, "released", `${activeKind} must hold capacity reservation`);
    assert.notEqual(view.policy.capacityDisposition, "free", `${activeKind} capacity disposition stays busy`);
    assert.equal(
      dispatchAdmissionBlocker([view], { instanceId: "instance-a", owner: "local", capacity: 1 })?.code,
      "runtime_capacity_exhausted",
    );
  }
});

test("task writer admission spans instances and nodes and survives lease release until stop proof", () => {
  const ids = { dispatchId: "writer", runtimeSessionId: "writer-session", attemptGroupId: "writer" };
  const requested = runtimeEvent({ t: "R" }, ids, {
    instanceId: "other-instance",
    source: { kind: "node", nodeId: "other-node" },
    dispatch: { taskId: "task-writer", executionId: "execution-writer", role: "worker" },
  });
  const step = reduceDispatchLifecycle(null, requested, { taskLease: { executionId: "execution-writer", version: 1 } });
  assert.equal(step.kind, "applied");
  if (step.kind !== "applied") return;
  const view = dispatchLifecycleView(step.group);
  assert.equal(taskWriterConflict([view], "task-writer")?.code, "runtime_task_writer_conflict");
  assert.match(taskWriterConflict([view], "task-writer")!.message, /writer-session/u);
  assert.equal(taskWriterConflict([view], "another-task"), null);
  assert.equal(
    taskWriterConflict(
      [{ ...view, attempt: { ...view.attempt, task: { ...view.attempt.task!, leaseReleased: true } } }],
      "task-writer",
    )?.code,
    "runtime_task_writer_conflict",
  );
  assert.equal(
    taskWriterConflict([{ ...view, attempt: { ...view.attempt, stopProof: "proven_stopped" } }], "task-writer"),
    null,
  );
  for (const task of [
    { ...view.attempt.task!, role: "reviewer" as const },
    { ...view.attempt.task!, leaseVersion: null },
  ])
    assert.equal(taskWriterConflict([{ ...view, attempt: { ...view.attempt, task } }], "task-writer"), null);
});
