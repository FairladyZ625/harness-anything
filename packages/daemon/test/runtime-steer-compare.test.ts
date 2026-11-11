// harness-test-tier: fast
import { dispatchLifecycleReadOf, lifecycleEvent } from "./dispatch-lifecycle-read.fixtures.ts";
// #4372 compare-and-steer: a caller's stated expectation (repo, task/execution or taskless, dispatch
// leaf, steer version) is compared with the target in the same section that appends the steer.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { attachReceiptAcceptance } from "@harness-anything/kernel";
import { openDispatchStream, readDispatchStream } from "../src/dispatch-stream.ts";
import { validateDaemonGuiCommandReceipt } from "../src/protocol/daemon-protocol.contract.ts";
import { evaluateRepoCellAction } from "../src/repo-cell-authorization.ts";
import { steerRuntime } from "../src/runtime-spawn-control.ts";

const binding = { actor: { principal: { personId: "operator" }, executor: null }, source: "local" as const };
const A = "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa",
  B = "dispatch_bbbbbbbbbbbbbbbbbbbbbbbb",
  T = "dispatch_cccccccccccccccccccccccc",
  sessionA = "runtime_aaaaaaaaaaaaaaaaaaaaaaaa",
  sessionB = "runtime_bbbbbbbbbbbbbbbbbbbbbbbb",
  sessionT = "runtime_cccccccccccccccccccccccc";

function openStream(
  rootDir: string,
  dispatchId: string,
  runtimeSessionId: string,
  extra: { readonly task?: { readonly taskId: string; readonly executionId: string }; readonly resumedFrom?: string },
) {
  openDispatchStream(rootDir, {
    dispatchId,
    taskId: extra.task?.taskId ?? null,
    executionId: extra.task?.executionId ?? null,
    runtimeSessionId,
    instanceId: "instance-1",
    startedAt: "2026-11-07T00:00:00.000Z",
    dispatchOpId: `op-${dispatchId}`,
    kindId: "codex",
    permissionMode: null,
    binding,
    cwd: rootDir,
    prompt: "work",
    model: "gpt-5.6-sol",
    reasoningEffort: null,
    fast: false,
    ...(extra.resumedFrom ? { resumedFromDispatchId: extra.resumedFrom } : {}),
  });
}

function live(dispatchId: string, runtimeSessionId: string, pid = process.pid) {
  return { dispatchId, runtimeSessionId, kindId: "codex", providerSessionId: "provider-thread", process: { pid } };
}

/** Taskless conversation: round A (exited) resumed into leaf B (live); plus a live task-bound dispatch T. */
function fixture(t: { after: (fn: () => void) => void }) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-steer-compare-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  openStream(rootDir, A, sessionA, {});
  openStream(rootDir, B, sessionB, { resumedFrom: A });
  openStream(rootDir, T, sessionT, { task: { taskId: "task_x", executionId: "execution_x" } });
  const processes = new Map<string, unknown>([
    [sessionB, live(B, sessionB)],
    [sessionT, live(T, sessionT)],
  ]);
  const events = [
    [A, sessionA],
    [B, sessionB],
    [T, sessionT],
  ].flatMap(([dispatchId, sessionId]) => {
    const options = { source: "local" as const, instanceId: "instance-1", dispatchId };
    return [lifecycleEvent("R", sessionId!, options), lifecycleEvent("S", sessionId!, options)];
  });
  const context = {
    input: {
      rootDir,
      repoId: "repo-steer",
      now: () => "2026-11-07T00:01:00.000Z",
      remote: { readDispatchLifecycle: dispatchLifecycleReadOf(() => events) },
    },
    processes,
  };
  const steer = (payload: Record<string, unknown>) => steerRuntime(context as never, payload as never, binding);
  const steers = (dispatchId: string) =>
    readDispatchStream(rootDir, dispatchId)!.records.filter((record) => record.kind === "steer_requested");
  return { rootDir, processes, steer, steers, events };
}

/** Rejects with `code`, a diagnostic whose `actual` is the current target, and no stream append. */
async function refused(attempt: Promise<unknown>, code: string, field: string): Promise<Record<string, unknown>> {
  let caught: unknown;
  await attempt.then(
    () => assert.fail("expected the steer to be refused"),
    (error: unknown) => {
      caught = error;
    },
  );
  const error = caught as { code?: string; diagnostic?: { field: string; actual: string } };
  assert.equal(error.code, code, String(caught));
  assert.equal(error.diagnostic?.field, field, JSON.stringify(error.diagnostic));
  return JSON.parse(error.diagnostic!.actual) as Record<string, unknown>;
}

test("legacy selector-only steer keeps re-selecting the taskless leaf (previous protocol window)", async (t) => {
  // Negative control: an old dispatch id with no expectation is silently steered to the current leaf.
  const { steer, steers } = fixture(t);
  const receipt = await steer({ dispatchId: A, prompt: "legacy" });
  assert.equal(receipt.dispatchId, B);
  assert.equal(steers(A).length, 0);
  assert.equal(steers(B).length, 1);
});

test("an old leaf with expected leaf = old is refused instead of re-targeted, and returns the current leaf", async (t) => {
  const { steer, steers } = fixture(t);
  const current = await refused(
    steer({ dispatchId: A, prompt: "meant for A", expected: { dispatchId: A } }),
    "runtime_steer_target_changed",
    "expected.dispatchId",
  );
  assert.deepEqual(
    { dispatchId: current.dispatchId, leaf: current.leafDispatchId, taskless: current.taskless },
    { dispatchId: B, leaf: B, taskless: true },
  );
  assert.equal(current.liveness, "running");
  assert.equal(current.version, 0);
  assert.equal(steers(A).length + steers(B).length, 0, "a refusal appends nothing");
  // Re-read and retry with the leaf the refusal returned: exactly one request lands on B.
  const receipt = await steer({ dispatchId: A, prompt: "now for B", expected: { dispatchId: B, taskless: true } });
  assert.equal(receipt.dispatchId, B);
  assert.equal(steers(B).length, 1);
});

test("a directly addressed dispatch that is no longer its conversation's leaf is stale", async (t) => {
  const { processes, steer, steers } = fixture(t);
  processes.set(sessionA, live(A, sessionA));
  await refused(
    steer({ runtimeSessionId: sessionA, prompt: "old round", expected: { dispatchId: A } }),
    "runtime_steer_target_changed",
    "expected.dispatchId",
  );
  assert.equal(steers(A).length, 0);
});

test("taskless and task-bound identities cannot stand in for each other", async (t) => {
  const { steer, steers } = fixture(t);
  const task = await refused(
    steer({ runtimeSessionId: sessionT, prompt: "x", expected: { taskless: true } }),
    "runtime_steer_target_changed",
    "expected.taskless",
  );
  assert.deepEqual([task.taskId, task.executionId, task.taskless], ["task_x", "execution_x", false]);
  const taskless = await refused(
    steer({ dispatchId: B, prompt: "x", expected: { taskId: "task_x" } }),
    "runtime_steer_target_changed",
    "expected.taskId",
  );
  assert.deepEqual([taskless.taskId, taskless.taskless], [null, true]);
  assert.equal(steers(T).length + steers(B).length, 0);
});

test("wrong repo, task, or execution is refused with the current binding", async (t) => {
  const { steer, steers } = fixture(t);
  for (const [expected, field] of [
    [{ repoId: "repo-other", taskId: "task_x" }, "expected.repoId"],
    [{ taskId: "task_y" }, "expected.taskId"],
    [{ taskId: "task_x", executionId: "execution_old" }, "expected.executionId"],
  ] as const) {
    const current = await refused(
      steer({ dispatchId: T, prompt: "x", expected }),
      "runtime_steer_target_changed",
      field,
    );
    assert.deepEqual([current.repoId, current.taskId, current.executionId], ["repo-steer", "task_x", "execution_x"]);
  }
  assert.equal(steers(T).length, 0);
  const receipt = await steer({
    dispatchId: T,
    prompt: "fully matched",
    expected: { repoId: "repo-steer", taskId: "task_x", executionId: "execution_x", dispatchId: T, version: 0 },
  });
  assert.deepEqual(receipt.steerTarget, {
    repoId: "repo-steer",
    dispatchId: T,
    runtimeSessionId: sessionT,
    taskless: false,
    taskId: "task_x",
    executionId: "execution_x",
    version: 1,
    delivery: "requested",
  });
  assert.match(String(receipt.summary), /appended .* the provider has not confirmed it yet/u);
});

test("a stale steer version is refused; the returned version admits exactly one retry", async (t) => {
  const { steer, steers } = fixture(t);
  const first = await steer({ dispatchId: T, prompt: "one", expected: { version: 0 } });
  assert.equal((first.steerTarget as { version: number }).version, 1);
  const current = await refused(
    steer({ dispatchId: T, prompt: "two (stale view)", expected: { version: 0 } }),
    "runtime_steer_target_changed",
    "expected.version",
  );
  assert.equal(current.version, 1);
  const second = await steer({ dispatchId: T, prompt: "two", expected: { version: 1 } });
  assert.equal((second.steerTarget as { version: number }).version, 2);
  assert.deepEqual(
    steers(T).map((record) => [record.prompt, record.version]),
    [
      ["one", 1],
      ["two", 2],
    ],
  );
  // The same observation cannot be spent twice.
  await refused(
    steer({ dispatchId: T, prompt: "two again", expected: { version: 1 } }),
    "runtime_steer_target_changed",
    "expected.version",
  );
  assert.equal(steers(T).length, 2);
});

test("an exited provider is refused with liveness stopped in the returned target", async (t) => {
  const { processes, steer, steers, events } = fixture(t);
  events.push(lifecycleEvent("X", sessionT, { source: "local", instanceId: "instance-1" }));
  const exited = spawnSync(process.execPath, ["-e", ""]).pid;
  processes.set(sessionT, live(T, sessionT, exited));
  const current = await refused(
    steer({ dispatchId: T, prompt: "x", expected: { taskId: "task_x", dispatchId: T } }),
    "runtime_steer_unavailable",
    "target",
  );
  assert.equal(current.liveness, "stopped");
  assert.equal(steers(T).length, 0);
});

test("a malformed expectation is rejected before any target is read", async (t) => {
  const { steer } = fixture(t);
  for (const expected of [
    "dispatch",
    {},
    { leaf: B },
    { taskless: false },
    { taskless: true, taskId: "task_x" },
    { version: -1 },
    { version: 1.5 },
    { dispatchId: "" },
  ])
    await assert.rejects(steer({ dispatchId: B, prompt: "x", expected }), { code: "invalid_runtime_steer" });
});

test("the success receipt still passes the GUI write exit with the locked target", async (t) => {
  const { steer } = fixture(t);
  const receipt = await steer({ dispatchId: B, prompt: "x", expected: { dispatchId: B, version: 0 } }),
    wire = attachReceiptAcceptance(
      receipt as never,
      { readCommandOutcome: () => null } as never,
      { readCut: () => ({ watermark: 0 }) } as never,
    ) as unknown as Record<string, unknown>;
  assert.equal(wire.outcome, "applied");
  assert.deepEqual(validateDaemonGuiCommandReceipt(wire), [], JSON.stringify(wire));
});

test("an unauthorized caller is denied by the AuthorizationPort whatever expectation it states", async () => {
  const actor = { principal: { personId: "person_intruder" }, executor: null };
  for (const action of [
    { kind: "runtime-steer", dispatchId: T, prompt: "x" },
    { kind: "runtime-steer", dispatchId: T, prompt: "x", expected: { taskId: "task_x", dispatchId: T, version: 0 } },
  ]) {
    const decision = await evaluateRepoCellAction({
      action: action as never,
      binding: { actor, source: "local" },
      actionId: "steer-intruder",
      repoId: "repo-steer",
      revision: 1,
      now: "2026-11-07T00:00:00.000Z",
    });
    assert.equal(decision.outcome, "denied");
    assert.equal(decision.subject, "settings/repository");
  }
});
