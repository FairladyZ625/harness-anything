// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDispatchStream } from "../src/dispatch-stream.ts";
import { adoptRuntimes } from "../src/runtime-spawn-adoption.ts";
import { cancelRuntime } from "../src/runtime-spawn-control.ts";

const binding = { actor: { principal: { personId: "operator" }, executor: null }, source: "local" as const };

test("adoption settles an owned live session whose dispatch never recorded a process", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-missing-process-"));
  try {
    const dispatchId = "dispatch_dddddddddddddddddddddddd",
      runtimeSessionId = "runtime_dddddddddddddddddddddddd";
    openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "dispatch-op-missing-process");
    const settled: Array<{ readonly runtimeSessionId: string; readonly reason: string | null }> = [],
      context = {
        input: { rootDir, repoId: "missing-process", now: () => "2026-09-13T00:01:00.000Z" },
        requiredRuntimeProjection: () => ({ readRuntimeSessions: () => [liveSession(runtimeSessionId)] }),
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
      requiredRuntimeProjection: () => ({ readRuntimeSessions: () => [liveSession(runtimeSessionId)] }),
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
      else await assert.rejects(adoptRuntimes(context as never), /center disconnected/);
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

test("adoption reports only completed session restorations, never in-flight or failed settlement", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-adoption-progress-"));
  try {
    const sessions = ["a", "b", "c"].map((id) => liveSession(`runtime_${id.repeat(24)}`)),
      progress: number[] = [],
      settlements: string[] = [];
    for (const [index, session] of sessions.entries())
      openMissingProcessStream(
        rootDir,
        `dispatch_${String(index).repeat(24)}`,
        session.runtimeSessionId,
        `op-${index}`,
      );
    let release!: () => void, announceSecond!: () => void;
    const pending = new Promise<void>((resolve) => {
        release = resolve;
      }),
      secondStarted = new Promise<void>((resolve) => {
        announceSecond = resolve;
      });
    const context = {
      input: { rootDir, repoId: "adoption-progress", now: () => "2026-09-13T00:01:00.000Z" },
      requiredRuntimeProjection: () => ({ readRuntimeSessions: () => sessions }),
      processes: new Map(),
      exiting: new Set<string>(),
      consumeLine: async () => undefined,
      publishExit: async (active: { runtimeSessionId: string }) => {
        if (settlements.length === 1) {
          announceSecond();
          await pending;
        }
        assert.equal(progress.length, settlements.length, "starting settlement is not completed progress");
        if (settlements.length === 2) throw new Error("settlement stalled");
        settlements.push(active.runtimeSessionId);
        context.processes.delete(active.runtimeSessionId);
      },
    };
    const adopting = adoptRuntimes(context as never, (completed) => progress.push(completed));
    await secondStarted;
    try {
      assert.deepEqual(progress, [1]);
    } finally {
      release();
    }
    await assert.rejects(adopting, /settlement stalled/);
    assert.deepEqual(progress, [1, 2]);
    assert.equal(settlements.length, 2);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime cancel settles a live projection whose dispatch never recorded a process", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-cancel-missing-process-"));
  try {
    const dispatchId = "dispatch_eeeeeeeeeeeeeeeeeeeeeeee",
      runtimeSessionId = "runtime_eeeeeeeeeeeeeeeeeeeeeeee";
    openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "dispatch-op-cancel-missing-process");
    const published: Array<{ readonly type: string; readonly payload: Record<string, unknown> }> = [],
      context = {
        input: { rootDir, repoId: "cancel-missing-process" },
        requiredRuntimeProjection: () => ({ readRuntimeSessions: () => [liveSession(runtimeSessionId)] }),
        processes: new Map(),
        exiting: new Set<string>(),
        publishRuntimeEvent: async (type: string, payload: Record<string, unknown>) => {
          published.push({ type, payload });
          return {};
        },
        controlReceipt: (_opId: string, _runtimeSessionId: string, detail: string) => ({ detail }),
      };
    const receipt = await cancelRuntime(context as never, { runtimeSessionId }, binding);
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
            resultRef: `artifact:runtime-result/sha256/${createHash("sha256").update(runtimeSessionId).digest("hex")}`,
            result: null,
            reasonCode: "runtime_process_missing",
          },
        ],
      ],
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
