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
