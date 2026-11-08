// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { AgentRuntimeEventV1 } from "../../src/domain/agent-runtime.ts";
import {
  dispatchAdmissionBlocker,
  dispatchLifecycleAddress,
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
  options: { readonly instanceId?: string; readonly source?: AgentRuntimeEventV1["source"] } = {},
): AgentRuntimeEventV1 {
  revision += 1;
  const payload: Record<string, unknown> = { runtimeSessionId: ids.runtimeSessionId };
  if (token.t === "R")
    Object.assign(payload, {
      dispatchId: ids.dispatchId,
      instanceId: options.instanceId ?? "instance-a",
      ...(ids.attemptGroupId === ids.dispatchId ? {} : { attemptGroupId: ids.attemptGroupId }),
    });
  if (token.t === "L") payload.liveness = token.liveness;
  if (token.t === "O") {
    payload.outcome = token.outcome;
    if (token.classification || token.fallbackState)
      payload.attempt = {
        classification: token.classification ?? "worker_stop",
        reason: "fixture",
        ...(token.fallbackState ? { fallbackState: token.fallbackState } : {}),
      };
  }
  return {
    schema: "agent-runtime-event/v1",
    eventId: `event-${revision}`,
    workspaceRevision: revision,
    opId: `op-${revision}`,
    type: types[token.t],
    actor: { principal: { personId: "owner" }, executor: null },
    source: options.source ?? "local",
    occurredAt: "2026-11-08T00:00:00.000Z",
    payload,
  } as unknown as AgentRuntimeEventV1;
}

/** A minimal store: the same address resolution the projections perform. */
function fold(events: readonly AgentRuntimeEventV1[]) {
  const groups = new Map<string, DispatchLifecycleGroup>(),
    groupBySession = new Map<string, string>(),
    steps: DispatchLifecycleStep[] = [];
  for (const event of events) {
    const address = dispatchLifecycleAddress(event);
    if (address === null) continue;
    const groupId = address.by === "group" ? address.attemptGroupId : groupBySession.get(address.runtimeSessionId);
    const step = reduceDispatchLifecycle(groupId === undefined ? null : (groups.get(groupId) ?? null), event);
    steps.push(step);
    if (step.kind !== "applied") continue;
    groups.set(step.group.attemptGroupId, step.group);
    for (const attempt of step.group.attempts) groupBySession.set(attempt.runtimeSessionId, step.group.attemptGroupId);
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
