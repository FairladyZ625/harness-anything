// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AgentRuntimeEventV1 } from "../../src/domain/agent-runtime.ts";
import { submissionDigest } from "../../src/domain/submission-digest.ts";
import {
  dispatchAdmissionBlocker,
  dispatchAdmissionRefusal,
  dispatchLifecycleAddress,
  dispatchLifecycleTaskId,
  isDispatchLifecycleInput,
  taskLeaseAfter,
  type DispatchLifecycleInput,
  type DispatchTaskLease,
  dispatchLifecycleView,
  dispatchOwnerForNode,
  reduceDispatchLifecycle,
  type DispatchLifecycleGroup,
  type DispatchLifecycleStep,
} from "../../src/domain/dispatch-lifecycle.ts";

type Token = {
  readonly t: "R" | "S" | "L" | "C" | "X" | "O";
  readonly liveness?: string;
  readonly outcome?: string;
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
      ...(ids.attemptGroupId === ids.dispatchId ? {} : { attemptGroupId: ids.attemptGroupId }),
      ...options.dispatch,
    });
  if (token.t === "S") payload.launchGeneration = options.launchGeneration ?? 1;
  if (token.t === "L") payload.liveness = token.liveness;
  if (token.t === "O") {
    payload.outcome = token.outcome;
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

test("a stopped dispatch cannot be recovered while its replacement lease generation is held", () => {
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
    [2, false, false],
  );
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
