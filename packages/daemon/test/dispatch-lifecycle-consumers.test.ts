// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { dispatchAdmissionRefusal } from "@harness-anything/kernel";
import { prepareRuntimeInstance } from "../src/runtime-spawn-mission.ts";
import { liveDispatchIn } from "../src/live-dispatch-worktree.ts";
import { readActiveDispatchLifecycleSync } from "../src/runtime-dispatch-admission.ts";
import { runtimeSpawnError } from "../src/runtime-spawn-errors.ts";
import { requireCurrentExecutionScope } from "../src/runtime-execution-scope.ts";
import { runtimeExecutionActor } from "../src/runtime-execution-credential.ts";
import { dispatchLifecycleReadOf, lifecycleEvent } from "./dispatch-lifecycle-read.fixtures.ts";

const principal = {
  repoId: "repo",
  personId: "owner",
  role: "session" as const,
  runtimeSessionId: "session",
  dispatchId: "dispatch",
  taskId: null,
  executionId: null,
  source: "local" as const,
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const actor = runtimeExecutionActor(principal);
const options = { source: "local" as const, instanceId: "instance", dispatchId: "dispatch" };

test("execution writes follow accepted lifecycle closure even when the old session still says live", () => {
  const events = [lifecycleEvent("R", "session", options), lifecycleEvent("S", "session", options)];
  const projection = {
    readDispatchLifecycle: dispatchLifecycleReadOf(() => events),
    readRuntimeSession: () => ({ liveness: "live", outcome: null, taskBindings: [] }),
    readRuntimeDispatch: () => ({ actor, source: "local", payload: { dispatchId: "dispatch" } }),
  };
  const input = {
    action: { kind: "task-create", title: "task" },
    binding: { actor, source: "local" as const, executionPrincipal: principal },
    projection: projection as never,
    now: "2026-11-11T00:00:00.000Z",
  };
  assert.doesNotThrow(() => requireCurrentExecutionScope(input));
  events.push(lifecycleEvent("X", "session", options));
  assert.throws(() => requireCurrentExecutionScope(input), { code: "execution_credential_rejected" });
});

test("workspace ownership survives a stopped backoff attempt and active pagination reaches the final page", () => {
  const events = Array.from({ length: 101 }, (_, i) =>
    lifecycleEvent("R", `session-${String(i).padStart(3, "0")}`, { source: "local", instanceId: "instance" }),
  );
  const source = lifecycleEvent("R", "workspace", {
    source: "local",
    instanceId: "instance",
    dispatchId: "dispatch-workspace",
  });
  events.push({ ...source, payload: { ...source.payload, cwd: "/fixture/worktree" } } as never);
  const closed = lifecycleEvent("O", "workspace", { source: "local", instanceId: "instance" });
  events.push({
    ...closed,
    payload: { ...closed.payload, outcome: "failed", attempt: { fallbackState: "scheduled" } },
  } as never);
  const read = dispatchLifecycleReadOf(() => events);
  const active = readActiveDispatchLifecycleSync(read, runtimeSpawnError);
  assert.equal(active.length, 102);
  const view = active.find(({ attempt }) => attempt.runtimeSessionId === "workspace")!;
  assert.equal(view.policy.capacity, "released");
  assert.equal(view.policy.canHandoff, false);
  assert.equal(view.policy.canSteer, false);
  assert.equal(liveDispatchIn(active, "/fixture/worktree"), true);
  assert.equal(liveDispatchIn(active, "/fixture/worktree-neighbour"), false);
});

test("capacity ranking and instance reuse follow reservations even when session summaries disagree", async () => {
  const events = [lifecycleEvent("R", "reservation", { source: "local", instanceId: "a" })];
  const read = dispatchLifecycleReadOf(() => events);
  const select = async () => {
    const capacity = readActiveDispatchLifecycleSync(read, runtimeSpawnError);
    const instance = (instanceId: string) => ({
      instanceId,
      kindId: "codex",
      enabled: true,
      models: ["model"],
      authReadiness: { status: "ready", code: null },
    });
    return prepareRuntimeInstance(
      {
        agent: null,
        runtimeKind: "codex",
        allowedInstanceIds: ["a", "b"],
        instances: [instance("a"), instance("b")] as never,
        sessions: [
          { runtimeSessionId: "stale", instanceId: "b", liveness: "live", outcome: null, providerSessionId: null },
        ],
        capacity,
      },
      async (id) => id,
    );
  };
  assert.equal((await select()).instanceId, "b", "reserved a counts, stale session summary for b does not");
  const [busy] = readActiveDispatchLifecycleSync(read, runtimeSpawnError);
  assert.ok(
    dispatchAdmissionRefusal({ group: null, instance: [busy!], instanceId: "a", owner: "local", capacity: 1 }),
    "a different group cannot exceed instance capacity",
  );
  events.push(lifecycleEvent("X", "reservation", { source: "local", instanceId: "a" }));
  assert.equal((await select()).instanceId, "a", "an accepted stop releases the same instance for reuse");
});
