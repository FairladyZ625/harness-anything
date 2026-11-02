// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendRuntimeWorkerRecord,
  archiveDispatchStream,
  openDispatchStream,
  readDispatchStream,
} from "../src/dispatch-stream.ts";
import { attachReceiptAcceptance } from "@harness-anything/kernel";
import { validateDaemonGuiCommandReceipt } from "../src/protocol/daemon-protocol.contract.ts";
import { adoptRuntimes } from "../src/runtime-spawn-adoption.ts";
import { runtimeSpawnError } from "../src/runtime-spawn-errors.ts";
import { cancelRuntime, steerRuntime } from "../src/runtime-spawn-control.ts";
import { makeRuntimeSpawner } from "../src/runtime-spawner.ts";
import { ModelSlotQueue } from "../src/runtime/model-slot-queue.ts";
import type { RuntimeSpawnerInput } from "../src/runtime-spawn-types.ts";

const binding = { actor: { principal: { personId: "operator" }, executor: null }, source: "local" as const };

test("adoption cannot settle a launch that still owns its model slot before PID registration", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-launch-adoption-race-")),
    entered = Promise.withResolvers<string>(),
    release = Promise.withResolvers<void>(),
    modelSlotQueue = new ModelSlotQueue({ globalCapacity: 2, perOwnerCapacity: 2 }),
    dispatchId = "dispatch_121212121212121212121212";
  let publishedSessionId: string | null = null;
  const spawner = makeRuntimeSpawner({
    repoId: "launch-adoption-race",
    rootDir,
    daemonGeneration: 1,
    modelSlotQueue,
    store: () => ({ readEvent: () => null }),
    projection: () => ({
      readRuntimeSessions: () => (publishedSessionId ? [liveSession(publishedSessionId)] : []),
      readRuntimeDispatch: () => ({ source: "local", payload: { dispatchId } }),
      currentLease: () => null,
      getEntity: () => ({ value: { runtime: { allowedInstances: ["worker"] } } }),
    }),
    runtimeInstances: () => [
      {
        instanceId: "worker",
        name: "Worker",
        kindId: "codex",
        models: ["gpt-5.6-sol"],
        defaultModel: "gpt-5.6-sol",
        enabled: true,
        authMode: "subscription",
        authReadiness: { status: "ready", code: null, hint: null },
        permissionMode: "bypass",
      },
    ],
    prepareLaunch: async (_instanceId, request) => {
      entered.resolve(request.runtimeSessionId!);
      await release.promise;
      throw new Error("controlled preparation refusal");
    },
    // Maintenance is independent of the adoption whose ownership this test exercises.
    schedule: () => undefined,
    now: () => "2026-11-01T00:00:00.000Z",
  } as unknown as RuntimeSpawnerInput);
  const launch = assert.rejects(
    spawner.spawn(
      {
        runtimeInstanceId: "worker",
        cwd: { scope: "repo-root" },
        prompt: "Hold the local attempt",
        dispatchKey: "held-launch",
      },
      binding,
    ),
    /controlled preparation refusal/u,
  );
  try {
    publishedSessionId = await entered.promise;
    assert.equal(modelSlotQueue.position(publishedSessionId), 0);
    assert.equal((await spawner.adopt())[0]?.outcome, "ready", "the launch also owns the pre-header window");
    // A center publication can become readable before the local process registration.
    openMissingProcessStream(rootDir, dispatchId, publishedSessionId, "held-launch");
    const recovery = await spawner.adopt();
    assert.equal(
      readDispatchStream(rootDir, dispatchId)!.records.some((record) => record.kind === "process_lost"),
      false,
    );
    assert.equal(recovery[0]?.outcome, "ready");
    release.resolve();
    await launch;
    assert.equal(
      modelSlotQueue.position(publishedSessionId),
      null,
      "failed preparation releases the existing reservation",
    );
  } finally {
    release.resolve();
    await launch;
    spawner.close();
    modelSlotQueue.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("adoption settles an owned live session whose dispatch never recorded a process", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-missing-process-"));
  try {
    const dispatchId = "dispatch_dddddddddddddddddddddddd",
      runtimeSessionId = "runtime_dddddddddddddddddddddddd";
    openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "dispatch-op-missing-process");
    const settled: Array<{ readonly runtimeSessionId: string; readonly reason: string | null }> = [],
      context = {
        input: { rootDir, repoId: "missing-process", now: () => "2026-09-13T00:01:00.000Z" },
        requiredRuntimeProjection: () => ({
          readRuntimeSessions: () => [liveSession(runtimeSessionId)],
          readRuntimeDispatch: () => ({ source: "local", payload: { dispatchId } }),
        }),
        processes: new Map(),
        exiting: new Set<string>(),
        reconcileFallback: () => undefined,
        consumeLine: async () => undefined,
        publishExit: async (active: { runtimeSessionId: string; lossReason: string | null }) => {
          settled.push({ runtimeSessionId: active.runtimeSessionId, reason: active.lossReason });
          context.processes.delete(active.runtimeSessionId);
        },
      };
    await adoptRuntimes(context as never);
    assert.deepEqual(settled, [
      { runtimeSessionId, reason: "runtime process was never recorded before daemon restart" },
    ]);
    assert.equal(context.processes.size, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("adoption replays an archived dead dispatch whose canonical outcome was not projected", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-archived-dead-process-"));
  try {
    const dispatchId = "dispatch_acacacacacacacacacacacac",
      runtimeSessionId = "runtime_acacacacacacacacacacacac";
    openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "dispatch-op-archived-dead-process");
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 2_147_483_646 });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_exit", exitCode: 1, signal: null });
    archiveDispatchStream(rootDir, dispatchId);
    const settled: Array<{ readonly runtimeSessionId: string; readonly lossReason: string | null }> = [],
      context = {
        input: { rootDir, repoId: "archived-dead-process", now: () => "2026-10-31T04:00:00.000Z" },
        requiredRuntimeProjection: () => ({
          readRuntimeSessions: () => [liveSession(runtimeSessionId)],
          readRuntimeDispatch: () => ({ source: "local", payload: { dispatchId } }),
        }),
        processes: new Map(),
        exiting: new Set<string>(),
        reconcileFallback: () => undefined,
        consumeLine: async () => undefined,
        publishExit: async (active: { runtimeSessionId: string; lossReason: string | null }) => {
          settled.push({ runtimeSessionId: active.runtimeSessionId, lossReason: active.lossReason });
          context.processes.delete(active.runtimeSessionId);
        },
      };
    await adoptRuntimes(context as never);
    assert.deepEqual(settled, [{ runtimeSessionId, lossReason: null }]);
    assert.equal(context.processes.size, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("recovery adoption preserves a runtime already owned by this daemon", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-owned-runtime-adoption-"));
  try {
    const dispatchId = "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa",
      runtimeSessionId = "runtime_aaaaaaaaaaaaaaaaaaaaaaaa";
    openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "owned-runtime");
    const owned = { runtimeSessionId },
      processes = new Map([[runtimeSessionId, owned]]);
    const context = {
      input: { rootDir, repoId: "owned-runtime", now: () => "2026-09-13T00:01:00.000Z" },
      requiredRuntimeProjection: () => ({
        readRuntimeSessions: () => [liveSession(runtimeSessionId)],
        readRuntimeDispatch: () => ({ source: "local", payload: { dispatchId } }),
      }),
      processes,
      exiting: new Set<string>(),
      reconcileFallback: () => {
        throw new Error("a live owned runtime must not be reconciled twice");
      },
      consumeLine: async () => undefined,
      publishExit: async () => {
        throw new Error("a live owned runtime must not be settled as missing");
      },
    };
    await adoptRuntimes(context as never);
    await adoptRuntimes(context as never);
    assert.equal(processes.get(runtimeSessionId), owned);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

for (const failurePoint of ["liveness", "settlement", "in-flight"] as const) {
  test(`adoption of a missing process handles ${failurePoint} without orphan ownership`, async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-adoption-retry-"));
    try {
      const dispatchId = "dispatch_bbbbbbbbbbbbbbbbbbbbbbbb",
        runtimeSessionId = "runtime_bbbbbbbbbbbbbbbbbbbbbbbb";
      openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "retry-adoption");
      let unavailable = true,
        settled = 0;
      const context = {
        input: { rootDir, repoId: "retry-adoption", now: () => "2026-09-13T00:01:00.000Z" },
        requiredRuntimeProjection: () => ({
          readRuntimeSessions: () => [{ ...liveSession(runtimeSessionId), liveness: "unknown" }],
          readRuntimeDispatch: () => ({ source: "local", payload: { dispatchId } }),
        }),
        processes: new Map(),
        exiting: new Set(failurePoint === "in-flight" ? [runtimeSessionId] : []),
        consumeLine: async () => undefined,
        publishRuntimeEvent: async () => {
          assert.fail("a missing process must never publish live before settlement");
        },
        publishExit: async (active: { runtimeSessionId: string }) => {
          if (context.exiting.has(active.runtimeSessionId)) return;
          if (unavailable && failurePoint === "settlement") throw new Error("center disconnected");
          settled++;
          context.processes.delete(active.runtimeSessionId);
        },
      };
      if (failurePoint === "liveness") {
        await adoptRuntimes(context as never);
        assert.equal(settled, 1);
        assert.equal(context.processes.size, 0);
        return;
      }
      if (failurePoint === "in-flight") await adoptRuntimes(context as never);
      else assert.equal((await adoptRuntimes(context as never))[0]?.outcome, "failed");
      assert.equal(context.processes.size, 0, "failed or in-flight adoption must not leave an owned runtime");
      unavailable = false;
      context.exiting.clear();
      await adoptRuntimes(context as never);
      assert.equal(settled, 1);
      assert.equal(context.processes.size, 0);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}

test("adoption reports completed restores independently of a pending or failed sibling", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-adoption-progress-"));
  const pending = Promise.withResolvers<void>(),
    secondStarted = Promise.withResolvers<void>();
  try {
    const sessions = ["a", "b", "c"].map((id) => liveSession(`runtime_${id.repeat(24)}`));
    const progress: number[] = [];
    for (const [index, session] of sessions.entries())
      openMissingProcessStream(
        rootDir,
        `dispatch_${String(index).repeat(24)}`,
        session.runtimeSessionId,
        `op-${index}`,
      );
    const context = {
      input: { rootDir, now: () => "2026-09-13T00:01:00.000Z" },
      requiredRuntimeProjection: () => ({
        readRuntimeSessions: () => sessions,
        readRuntimeDispatch: (id: string) => ({
          source: "local",
          payload: {
            dispatchId: `dispatch_${String(sessions.findIndex((s) => s.runtimeSessionId === id)).repeat(24)}`,
          },
        }),
      }),
      processes: new Map(),
      exiting: new Set<string>(),
      consumeLine: async () => undefined,
      publishExit: async (active: { runtimeSessionId: string }) => {
        if (active.runtimeSessionId === sessions[1]!.runtimeSessionId) {
          secondStarted.resolve();
          await pending.promise;
        }
        if (active.runtimeSessionId === sessions[2]!.runtimeSessionId) throw new Error("settlement stalled");
        context.processes.delete(active.runtimeSessionId);
      },
    };
    const adopting = adoptRuntimes(context as never, (completed) => progress.push(completed));
    await secondStarted.promise;
    pending.resolve();
    assert.deepEqual(
      (await adopting).map((r) => r.outcome),
      ["ready", "ready", "failed"],
    );
    assert.deepEqual(progress, [1, 2]);
  } finally {
    pending.resolve();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime cancel settles a live projection whose dispatch never recorded a process", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-cancel-missing-process-"));
  try {
    const dispatchId = "dispatch_eeeeeeeeeeeeeeeeeeeeeeee",
      runtimeSessionId = "runtime_eeeeeeeeeeeeeeeeeeeeeeee";
    openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "dispatch-op-cancel-missing-process");
    const published: Array<{
        readonly type: string;
        readonly payload: Record<string, unknown>;
        readonly resultBody?: string;
      }> = [],
      context = {
        input: { rootDir, repoId: "cancel-missing-process" },
        requiredRuntimeProjection: () => ({
          readRuntimeSessions: () => [liveSession(runtimeSessionId)],
          readRuntimeDispatch: () => ({ source: "local", payload: { dispatchId } }),
        }),
        processes: new Map(),
        exiting: new Set<string>(),
        publishRuntimeEvent: async (
          type: string,
          payload: Record<string, unknown>,
          _opId: string,
          _binding: unknown,
          resultBody?: string,
        ) => {
          published.push({ type, payload, resultBody });
          return {};
        },
        controlReceipt: (_opId: string, _runtimeSessionId: string, detail: string) => ({ detail }),
      };
    const receipt = await cancelRuntime(
      context as never,
      { runtimeSessionId },
      { actor: binding.actor, source: { kind: "node", nodeId: "edge-a" } },
    );
    assert.equal(
      published.find(({ type }) => type === "runtime_session_outcome_observed")?.resultBody,
      "Runtime session cancelled after its worker process was no longer available.",
    );
    assert.equal(receipt.detail, "cancelled");
    assert.deepEqual(
      published.map(({ type, payload }) => [type, payload]),
      [
        ["runtime_session_cancelled", { runtimeSessionId }],
        ["runtime_session_exited", { runtimeSessionId }],
        [
          "runtime_session_outcome_observed",
          {
            runtimeSessionId,
            outcome: "cancelled",
            exitCode: null,
            resultRef: `artifact:runtime-result/sha256/${createHash("sha256").update("Runtime session cancelled after its worker process was no longer available.").digest("hex")}`,
            result: {
              sha256: createHash("sha256")
                .update("Runtime session cancelled after its worker process was no longer available.")
                .digest("hex"),
              size: Buffer.byteLength("Runtime session cancelled after its worker process was no longer available."),
              mediaType: "text/plain; charset=utf-8",
            },
            reasonCode: "runtime_process_missing",
          },
        ],
      ],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime cancel closes an exited session whose dispatch stream is missing", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-cancel-exited-missing-stream-"));
  try {
    const runtimeSessionId = "runtime_exited_missing_stream",
      dispatchId = "dispatch_exited_missing_stream",
      published: string[] = [],
      context = {
        input: {
          rootDir,
          repoId: "cancel-exited-missing-stream",
          runtimeNode: { nodeId: "edge-a" },
          remote: {
            readRuntimeSessions: async () => [{ ...liveSession(runtimeSessionId), liveness: "exited" }],
            readRuntimeDispatch: async () => ({
              actor: binding.actor,
              source: { kind: "node" as const, nodeId: "edge-a" },
              payload: { dispatchId },
              instanceId: "instance-exited-missing-stream",
            }),
          },
        },
        processes: new Map(),
        exiting: new Set<string>(),
        publishRuntimeEvent: async (type: string) => {
          published.push(type);
          return {};
        },
        controlReceipt: (_opId: string, _runtimeSessionId: string, detail: string) => ({ detail }),
      };
    const receipt = await cancelRuntime(
      context as never,
      { runtimeSessionId },
      { actor: binding.actor, source: { kind: "node", nodeId: "edge-a" } },
    );
    assert.equal(receipt.detail, "cancelled");
    assert.deepEqual(published, [
      "runtime_session_cancelled",
      "runtime_session_exited",
      "runtime_session_outcome_observed",
    ]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime cancel settles a live remote session when the owner stream is gone", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-cancel-ghost-owner-"));
  try {
    const runtimeSessionId = "runtime_121212121212121212121212",
      dispatchId = "dispatch_121212121212121212121212",
      instanceId = "instance-ghost-owner",
      edgeBinding = {
        actor: binding.actor,
        source: { kind: "node" as const, nodeId: "edge-a" },
      },
      owner = {
        actor: edgeBinding.actor,
        source: edgeBinding.source,
        payload: { dispatchId },
        instanceId,
        processGroupPid: 2_147_483_646,
      },
      published: string[] = [],
      reclaimed: Array<[string, string]> = [],
      context = {
        input: {
          rootDir,
          repoId: "cancel-ghost-owner",
          runtimeNode: { nodeId: "edge-a" },
          reclaimRuntimeTempDirectory: (ownerInstanceId: string, ownerRuntimeSessionId: string) => {
            reclaimed.push([ownerInstanceId, ownerRuntimeSessionId]);
            return null;
          },
          remote: {
            readRuntimeSessions: async () => [liveSession(runtimeSessionId)],
            readRuntimeDispatch: async () => owner,
          },
        },
        processes: new Map(),
        exiting: new Set<string>(),
        runtimeSpawnError,
        publishRuntimeEvent: async (type: string) => {
          published.push(type);
          return {};
        },
        controlReceipt: (_opId: string, _runtimeSessionId: string, detail: string) => ({ detail }),
      };
    assert.equal((await adoptRuntimes(context as never))[0]?.outcome, "failed");
    const receipt = await cancelRuntime(context as never, { runtimeSessionId }, edgeBinding);
    assert.equal(receipt.detail, "cancelled");
    assert.deepEqual(reclaimed, [[instanceId, runtimeSessionId]]);
    assert.deepEqual(published, [
      "runtime_session_cancelled",
      "runtime_session_exited",
      "runtime_session_outcome_observed",
    ]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime cancel refuses to settle an owner session when its process group is unproven", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-cancel-unproven-owner-"));
  try {
    const runtimeSessionId = "runtime_131313131313131313131313",
      edgeBinding = { actor: binding.actor, source: { kind: "node" as const, nodeId: "edge-a" } },
      context = {
        input: {
          rootDir,
          repoId: "cancel-unproven-owner",
          runtimeNode: { nodeId: "edge-a" },
          remote: {
            readRuntimeSessions: async () => [{ ...liveSession(runtimeSessionId), liveness: "unknown" }],
            readRuntimeDispatch: async () => ({
              actor: edgeBinding.actor,
              source: edgeBinding.source,
              dispatchId: "dispatch_131313131313131313131313",
              instanceId: "instance-unproven-owner",
              processGroupPid: null,
            }),
          },
        },
        processes: new Map(),
        exiting: new Set<string>(),
        publishRuntimeEvent: async () => assert.fail("unproven owner process group must not settle"),
      };
    await assert.rejects(
      cancelRuntime(context as never, { runtimeSessionId }, edgeBinding),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_process_group_unproven",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime cancel cannot settle a remote owner's runtime from another node", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-cancel-foreign-owner-"));
  try {
    const runtimeSessionId = "runtime_141414141414141414141414",
      foreignBinding = { actor: binding.actor, source: { kind: "node" as const, nodeId: "edge-b" } },
      context = {
        input: {
          rootDir,
          repoId: "cancel-foreign-owner",
          runtimeNode: { nodeId: "edge-b" },
          remote: {
            readRuntimeSessions: async () => [liveSession(runtimeSessionId)],
            readRuntimeDispatch: async () => ({
              actor: binding.actor,
              source: { kind: "node" as const, nodeId: "edge-a" },
              dispatchId: "dispatch_141414141414141414141414",
              instanceId: "instance-foreign-owner",
              processGroupPid: 2_147_483_646,
            }),
          },
        },
        processes: new Map(),
        exiting: new Set<string>(),
        publishRuntimeEvent: async () => assert.fail("another node cannot settle the owner runtime"),
      };
    await assert.rejects(
      cancelRuntime(context as never, { runtimeSessionId }, foreignBinding),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "execution_scope_mismatch",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime cancel on a non-owner converges after the owner publishes a terminal outcome", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-cancel-terminal-remote-owner-"));
  try {
    const runtimeSessionId = "runtime_151515151515151515151515",
      foreignBinding = { actor: binding.actor, source: { kind: "node" as const, nodeId: "edge-b" } },
      published: string[] = [],
      context = {
        input: {
          rootDir,
          repoId: "cancel-terminal-remote-owner",
          runtimeNode: { nodeId: "edge-b" },
          remote: {
            readRuntimeSessions: async () => [
              { ...liveSession(runtimeSessionId), liveness: "exited", outcome: "succeeded" },
            ],
            readRuntimeDispatch: async () => ({
              actor: binding.actor,
              source: { kind: "node" as const, nodeId: "edge-a" },
              payload: { dispatchId: "dispatch_151515151515151515151515" },
              instanceId: "instance-terminal-owner",
              processGroupPid: 2_147_483_646,
            }),
          },
        },
        processes: new Map(),
        exiting: new Set<string>(),
        publishRuntimeEvent: async (type: string) => {
          published.push(type);
          return {};
        },
        controlReceipt: (_opId: string, _runtimeSessionId: string, detail: string) => ({ detail }),
      };
    const receipt = await cancelRuntime(context as never, { runtimeSessionId }, foreignBinding);
    assert.equal(receipt.detail, "already-exited");
    assert.deepEqual(published, [], "a non-owner must observe terminal state without writing owner events");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime steer records the requesting actor and prompt without settling the dispatch", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-steer-"));
  try {
    const dispatchId = "dispatch_ffffffffffffffffffffffff",
      runtimeSessionId = "runtime_ffffffffffffffffffffffff";
    openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "dispatch-op-steer");
    const active = {
        dispatchId,
        runtimeSessionId,
        kindId: "codex",
        providerSessionId: "provider-thread",
        process: { pid: process.pid },
      },
      context = {
        input: { rootDir, repoId: "steer-test", now: () => "2026-09-13T00:01:00.000Z" },
        processes: new Map([[runtimeSessionId, active]]),
      };
    const receipt = await steerRuntime(
      context as never,
      { dispatchId, prompt: "Stop exploring; fix the parser." },
      binding,
    );
    assert.equal(receipt.outcome, "applied");
    const records = readDispatchStream(rootDir, dispatchId)!.records;
    assert.deepEqual(
      records.filter((record) => record.kind === "steer_requested").map((record) => [record.actor, record.prompt]),
      [[binding.actor, "Stop exploring; fix the parser."]],
    );
    assert.equal(
      records.some((record) => record.kind === "process_exit"),
      false,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a successful steer receipt survives the GUI write exit instead of reporting ok must be false", async () => {
  // The reported defect: the prompt reached the dispatch stream, but the CLI answered
  // `invalid_result: field=ok; actual=true; must be false`. The steer receipt was passed through
  // ledger acceptance even though steer never writes the ledger, so `applied` became
  // `indeterminate` while `ok` stayed true — a shape the GUI receipt exit has to reject.
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-steer-gui-receipt-"));
  try {
    const dispatchId = "dispatch_bbbbbbbbbbbbbbbbbbbbbbbb",
      runtimeSessionId = "runtime_bbbbbbbbbbbbbbbbbbbbbbbb";
    openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "dispatch-op-steer-gui-receipt");
    const context = {
        input: { rootDir, repoId: "steer-gui-receipt", now: () => "2026-09-13T00:01:00.000Z" },
        processes: new Map([
          [
            runtimeSessionId,
            {
              dispatchId,
              runtimeSessionId,
              kindId: "codex",
              providerSessionId: "provider-thread",
              process: { pid: process.pid },
            },
          ],
        ]),
      },
      receipt = await steerRuntime(context as never, { dispatchId, prompt: "Also cover the timeout." }, binding),
      // `repo.agentRuntime.steer` answers through its own RPC branch: the receipt goes straight to
      // parseDaemonGuiActionResult, with no makeDaemonCommandReceipt to recompute `ok`. That is why
      // the reported failure shows actual=true — the acceptance step had already turned the outcome
      // indeterminate while `ok` stayed true. A store without a command outcome is production's
      // state: a steer appends to the dispatch stream and never to the ledger.
      wire = attachReceiptAcceptance(
        receipt as never,
        { readCommandOutcome: () => null } as never,
        { readCut: () => ({ watermark: 0 }) } as never,
      ) as unknown as Record<string, unknown>;
    assert.equal(wire.ok, true, JSON.stringify(wire));
    assert.equal(wire.outcome, "applied", JSON.stringify(wire));
    assert.deepEqual(validateDaemonGuiCommandReceipt(wire), [], JSON.stringify(wire));
    assert.equal(
      readDispatchStream(rootDir, dispatchId)!.records.some((record) => record.kind === "steer_requested"),
      true,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime steer applies to an ACP kind through the dispatch stream, adopted process included", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-steer-acp-"));
  try {
    const dispatchId = "dispatch_0123456789abcdef01234567",
      runtimeSessionId = "runtime_0123456789abcdef01234567";
    openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "dispatch-op-steer-acp");
    // An adopted process has no in-memory control handle; the dispatch stream is the channel.
    const active = {
        dispatchId,
        runtimeSessionId,
        kindId: "codex-acp",
        providerSessionId: "provider-session",
        process: { pid: process.pid },
      },
      context = {
        input: { rootDir, repoId: "steer-acp-test", now: () => "2026-09-13T00:01:00.000Z" },
        processes: new Map([[runtimeSessionId, active]]),
      };
    const receipt = await steerRuntime(
      context as never,
      { runtimeSessionId, prompt: "Focus on the failing test." },
      binding,
    );
    assert.equal(receipt.outcome, "applied");
    assert.equal(receipt.runtimeSessionId, runtimeSessionId);
    assert.deepEqual(
      readDispatchStream(rootDir, dispatchId)!
        .records.filter((record) => record.kind === "steer_requested")
        .map((record) => record.prompt),
      ["Focus on the failing test."],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime steer still refuses before the provider established a session", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-steer-unbound-"));
  try {
    const dispatchId = "dispatch_111111111111111111111111",
      runtimeSessionId = "runtime_111111111111111111111111";
    openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "dispatch-op-steer-unbound");
    const context = {
      input: { rootDir, repoId: "steer-unbound-test", now: () => "2026-09-13T00:01:00.000Z" },
      processes: new Map([
        [
          runtimeSessionId,
          {
            dispatchId,
            runtimeSessionId,
            kindId: "codex-acp",
            providerSessionId: null,
            process: { pid: process.pid },
          },
        ],
      ]),
    };
    await assert.rejects(
      steerRuntime(context as never, { runtimeSessionId, prompt: "Continue" }, binding),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_steer_unavailable",
    );
    assert.equal(
      readDispatchStream(rootDir, dispatchId)!.records.some((record) => record.kind === "steer_requested"),
      false,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime steer rejects a provider without a declared steer strategy", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-steer-unsupported-"));
  try {
    const dispatchId = "dispatch_eeeeeeeeeeeeeeeeeeeeeeee",
      runtimeSessionId = "runtime_eeeeeeeeeeeeeeeeeeeeeeee";
    openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "dispatch-op-steer-unsupported");
    const context = {
      input: { rootDir, repoId: "steer-test", now: () => "2026-09-13T00:01:00.000Z" },
      processes: new Map([
        [
          runtimeSessionId,
          {
            dispatchId,
            runtimeSessionId,
            kindId: "agy",
            providerSessionId: "provider-session",
            process: { pid: process.pid },
          },
        ],
      ]),
    };
    await assert.rejects(
      steerRuntime(context as never, { runtimeSessionId, prompt: "Continue" }, binding),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_steer_unsupported",
    );
    assert.equal(
      readDispatchStream(rootDir, dispatchId)!.records.some((record) => record.kind === "steer_requested"),
      false,
      "a rejected steer must not write a command record",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime steer refuses a dispatch whose worker host is already gone", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-steer-dead-host-"));
  try {
    const dispatchId = "dispatch_dddddddddddddddddddddddd",
      runtimeSessionId = "runtime_dddddddddddddddddddddddd";
    openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "dispatch-op-steer-dead-host");
    const context = {
      input: { rootDir, repoId: "steer-dead-host-test", now: () => "2026-09-13T00:01:00.000Z" },
      processes: new Map([
        [
          runtimeSessionId,
          {
            dispatchId,
            runtimeSessionId,
            kindId: "codex-acp",
            providerSessionId: "provider-session",
            // A pid that cannot exist: the request would land in a stream nobody follows, so the
            // command must be refused rather than reported as applied.
            process: { pid: 2_147_483_646 },
          },
        ],
      ]),
    };
    await assert.rejects(
      steerRuntime(context as never, { runtimeSessionId, prompt: "Continue" }, binding),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_steer_unavailable",
    );
    assert.equal(
      readDispatchStream(rootDir, dispatchId)!.records.some((record) => record.kind === "steer_requested"),
      false,
      "a refused steer must not leave a command record behind",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function openMissingProcessStream(rootDir: string, dispatchId: string, runtimeSessionId: string, dispatchOpId: string) {
  openDispatchStream(rootDir, {
    dispatchId,
    taskId: null,
    executionId: null,
    runtimeSessionId,
    instanceId: "instance-1",
    startedAt: "2026-09-13T00:00:00.000Z",
    dispatchOpId,
    kindId: "codex",
    permissionMode: null,
    binding,
    cwd: rootDir,
    prompt: "missing process",
    model: "gpt-5.6-sol",
    reasoningEffort: null,
    fast: false,
  });
}

function liveSession(runtimeSessionId: string) {
  return { runtimeSessionId, instanceId: "instance-1", providerSessionId: null, liveness: "live", outcome: null };
}
