// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { adoptRuntimes, ownedByRuntimeSpawner } from "../src/runtime-spawn-adoption.ts";
import { cancelRuntime, closeRuntimes } from "../src/runtime-spawn-control.ts";
import { publishExit } from "../src/runtime-spawn-settlement.ts";
import { readDispatchStreamHeader } from "../src/dispatch-stream.ts";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/dispatch-stream.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import type { RuntimeBinding } from "../src/runtime-spawn-types.ts";

const owner = { nodeId: "node-one" };
const binding = (source: RuntimeBinding["source"]): RuntimeBinding => ({
  actor: { principal: { personId: "owner" } },
  source,
});
test("edge spawner owns exactly its authenticated node", () => {
  assert.equal(ownedByRuntimeSpawner(binding({ kind: "node", ...owner }), owner), true);
  assert.equal(ownedByRuntimeSpawner(binding({ kind: "node", ...owner, nodeId: "node-two" }), owner), false);
  assert.equal(ownedByRuntimeSpawner(binding("local"), owner), false);
});
test("local spawner owns only local dispatches on restart", () => {
  assert.equal(ownedByRuntimeSpawner(binding("local"), undefined), true);
  assert.equal(ownedByRuntimeSpawner(binding({ kind: "node", ...owner }), undefined), false);
});

for (const source of ["local", { kind: "node", nodeId: "request-origin" }] as const) {
  test(`local recovery replays an exited DeepSeek host's terminal stream (source=${typeof source === "string" ? source : "node"})`, async (t) => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-node-origin-recovery-"));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const dispatchId = "dispatch_333333333333333333333333",
      runtimeSessionId = "runtime-node-origin",
      dispatchBinding = binding(source),
      stream = openDispatchStream(rootDir, {
        dispatchId,
        runtimeSessionId,
        taskId: null,
        executionId: null,
        instanceId: "deepseek-worker",
        startedAt: "2026-11-02T07:00:00.000Z",
        dispatchOpId: dispatchId,
        kindId: "deepseek-harness",
        permissionMode: "bypass",
        cwd: rootDir,
        binding: dispatchBinding,
        prompt: "recover the exited worker",
        model: "deepseek-v4.1-flash",
        reasoningEffort: null,
      });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 2_147_483_647 });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_exit", exitCode: 0, signal: null });
    const body =
        "Review was not registered. Runtime archive publication failed: Writer session token resolver is unavailable",
      sha256 = createHash("sha256").update(body).digest("hex");
    stream.appendTerminalOutcome(
      {
        payload: {
          runtimeSessionId,
          outcome: "failed",
          exitCode: 0,
          resultRef: `artifact:runtime-result/sha256/${sha256}`,
          result: { sha256, size: Buffer.byteLength(body), mediaType: "text/plain; charset=utf-8" },
          endedAt: "2026-11-02T07:01:00.000Z",
        },
        body,
        reason: "Review was not registered before reviewer settlement.",
        processGroupPid: 2_147_483_647,
      },
      "2026-11-02T07:01:00.000Z",
    );
    const settled: string[] = [],
      published: string[] = [],
      context = {
        input: {
          rootDir,
          now: () => "2026-11-02T08:00:00.000Z",
          stream: { publish: () => undefined },
          onAttemptTerminal: ({ runtimeSessionId: id }: { runtimeSessionId: string }) => settled.push(id),
        },
        processes: new Map(),
        exiting: new Set(),
        requiredRuntimeProjection: () => ({
          readRuntimeSessions: () => [
            {
              runtimeSessionId,
              instanceId: "deepseek-worker",
              providerSessionId: null,
              liveness: "live",
              outcome: null,
            },
          ],
          readRuntimeDispatch: () => ({ ...dispatchBinding, payload: { dispatchId } }),
        }),
        publishExit: (active: Parameters<typeof publishExit>[1], code: number | null) =>
          publishExit(context, active, code),
        publishRuntimeEvent: async (type: string) => {
          published.push(type);
          return {};
        },
        runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
      } as unknown as RuntimeSpawnerContext;
    const result = await adoptRuntimes(context);
    assert.deepEqual(settled, [runtimeSessionId], `recovery result: ${JSON.stringify(result)}`);
    assert.equal(context.processes.size, 0);
    assert.deepEqual(published, ["runtime_session_exited", "runtime_session_outcome_observed"]);
  });
}

for (const authorized of [true, false]) {
  test(`explicit owner cancel recovers a node-origin durable terminal without borrowing the operator (authorized=${authorized})`, async (t) => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-node-owner-cancel-"));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const dispatchId = "dispatch_555555555555555555555555",
      runtimeSessionId = "runtime-node-cancel",
      ownerBinding = binding({ kind: "node", nodeId: "original-edge" }),
      stream = openDispatchStream(rootDir, {
        dispatchId,
        runtimeSessionId,
        taskId: null,
        executionId: null,
        instanceId: "deepseek-worker",
        startedAt: "2026-11-02T07:00:00.000Z",
        dispatchOpId: dispatchId,
        kindId: "deepseek-harness",
        permissionMode: "bypass",
        cwd: rootDir,
        binding: ownerBinding,
        prompt: "recover",
        model: "deepseek-v4.1-flash",
        reasoningEffort: null,
      });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 2_147_483_647 });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_exit", exitCode: 0, signal: null });
    stream.appendTerminalOutcome(
      {
        payload: {
          runtimeSessionId,
          outcome: "failed",
          exitCode: 0,
          result: null,
          resultRef: "artifact:runtime-result/sha256/" + createHash("sha256").update("durable failure").digest("hex"),
          endedAt: "2026-11-02T07:01:00.000Z",
        },
        body: "durable failure",
        reason: "review missing",
        processGroupPid: 2_147_483_647,
      },
      "2026-11-02T07:01:00.000Z",
    );
    const published: string[] = [],
      freshAuthorization = () => Promise.resolve("explicit-owner-token");
    const context = {
      input: {
        rootDir,
        repoId: "node-cancel",
        now: () => "2026-11-02T08:00:00.000Z",
        stream: { publish: () => undefined },
      },
      processes: new Map(),
      exiting: new Set(),
      requiredRuntimeProjection: () => ({
        readRuntimeSessions: () => [
          { runtimeSessionId, instanceId: "deepseek-worker", liveness: "live", outcome: null },
        ],
        readRuntimeDispatch: () => ({ ...ownerBinding, payload: { dispatchId } }),
      }),
      publishExit: (active: Parameters<typeof publishExit>[1], code: number | null) =>
        publishExit(context, active, code),
      publishRuntimeEvent: async (
        type: string,
        _payload: unknown,
        _opId: string,
        current: { source: unknown; keycloakAuthorization?: { session?: { currentAccessToken?: unknown } } },
      ) => {
        if (!current.keycloakAuthorization)
          throw Object.assign(new Error("owner must authorize recovery"), { code: "authentication_required" });
        assert.equal(current.keycloakAuthorization.session?.currentAccessToken, freshAuthorization);
        assert.deepEqual(current.source, ownerBinding.source, "recovery keeps the original write provenance");
        published.push(type);
        return {};
      },
      controlReceipt: () => ({ outcome: "cancelled" }),
      runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    } as unknown as RuntimeSpawnerContext;
    assert.equal(
      (await adoptRuntimes(context))[0]?.outcome,
      "failed",
      "startup cannot invent the original credentials",
    );
    const current = {
      ...binding("local"),
      actor: authorized ? ownerBinding.actor : { principal: { personId: "other-person" }, executor: null },
      keycloakAuthorization: { session: { currentAccessToken: freshAuthorization } },
    };
    const cancellation = cancelRuntime(context, { runtimeSessionId }, current);
    if (authorized) {
      await cancellation;
      assert.deepEqual(published, ["runtime_session_exited", "runtime_session_outcome_observed"]);
      assert.deepEqual(readDispatchStreamHeader(rootDir, dispatchId)?.binding, ownerBinding);
    } else {
      await assert.rejects(cancellation, { code: "execution_scope_mismatch" });
      assert.deepEqual(published, []);
    }
    assert.equal(context.processes.size, 0);
  });
}

test("execution host ownership is independent of write source and rejects a foreign host", () => {
  const origin = binding({ kind: "node", nodeId: "request-origin" }),
    header = { binding: origin, executionOwner: "local" } as never;
  assert.equal(ownedByRuntimeSpawner(origin, undefined, header), true);
  assert.equal(ownedByRuntimeSpawner(origin, { nodeId: "request-origin" }, header), false);
  assert.equal(
    ownedByRuntimeSpawner(origin, undefined, { binding: origin, executionOwner: { nodeId: "other" } } as never),
    false,
  );
  assert.equal(
    ownedByRuntimeSpawner(binding("local"), undefined, header),
    false,
    "canonical provenance must match the stream",
  );
});

test("node-origin recovery observes a living local worker without settling it", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-node-live-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const dispatchId = "dispatch_444444444444444444444444",
    runtimeSessionId = "runtime-live-node",
    ownerBinding = binding({ kind: "node", nodeId: "request-origin" });
  openDispatchStream(rootDir, {
    dispatchId,
    runtimeSessionId,
    taskId: null,
    executionId: null,
    instanceId: "deepseek-worker",
    startedAt: "2026-11-02T07:00:00.000Z",
    dispatchOpId: dispatchId,
    kindId: "deepseek-harness",
    permissionMode: "bypass",
    cwd: rootDir,
    binding: ownerBinding,
    prompt: "keep working",
    model: "deepseek-v4.1-flash",
    reasoningEffort: null,
  });
  appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: process.pid });
  const context = {
    input: { rootDir, now: () => "2026-11-02T08:00:00.000Z", schedule: () => undefined },
    processes: new Map(),
    exiting: new Set(),
    requiredRuntimeProjection: () => ({
      readRuntimeSessions: () => [{ runtimeSessionId, instanceId: "deepseek-worker", liveness: "live", outcome: null }],
      readRuntimeDispatch: () => ({ ...ownerBinding, payload: { dispatchId } }),
    }),
    publishExit: () => assert.fail("a living node-origin worker must not settle"),
    runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
  } as unknown as RuntimeSpawnerContext;
  t.after(() => closeRuntimes(context));
  assert.equal((await adoptRuntimes(context))[0]?.outcome, "ready");
  assert.equal(context.processes.get(runtimeSessionId)?.process.pid, process.pid);
});

test("recovery preserves a live DeepSeek worker already registered by this local spawner", async () => {
  const runtimeSessionId = "runtime-live-deepseek",
    active = { process: { pid: process.pid } },
    context = {
      input: { rootDir: tmpdir() },
      processes: new Map([[runtimeSessionId, active]]),
      exiting: new Set(),
      ownsModelSlot: () => true,
      requiredRuntimeProjection: () => ({
        readRuntimeSessions: () => [
          { runtimeSessionId, instanceId: "deepseek-worker", providerSessionId: null, liveness: "live", outcome: null },
        ],
        readRuntimeDispatch: () => {
          throw new Error("a registered launch must keep its existing owner");
        },
      }),
      publishExit: () => {
        throw new Error("a live worker must not be settled");
      },
    } as unknown as RuntimeSpawnerContext;
  assert.equal((await adoptRuntimes(context))[0]?.outcome, "ready");
  assert.equal(context.processes.get(runtimeSessionId), active);
});
