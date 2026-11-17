// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../src/dispatch-stream.ts";
import { cancelRuntime } from "../src/runtime-spawn-control.ts";
import { runtimeSpawnError } from "../src/runtime-spawn-errors.ts";
import { dispatchLifecycleReadOf, lifecycleEvent } from "./dispatch-lifecycle-read.fixtures.ts";

const binding = { actor: { principal: { personId: "operator" }, executor: null }, source: "local" as const };

test(
  "cancelRuntime continues owner cancellation when recovery fails after the process group is proven stopped",
  { skip: process.platform === "win32" ? "requires POSIX process-group probe semantics" : false },
  async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cancel-recovery-stopped-"));
    try {
      const dispatchId = "dispatch_919191919191919191919191",
        runtimeSessionId = "runtime_919191919191919191919191",
        published: string[] = [];
      openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "cancel-recovery-stopped");
      appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: 2_147_483_647 });
      appendRuntimeWorkerRecord(rootDir, dispatchId, {
        kind: "process_exit",
        occurredAt: "2026-11-02T00:00:05.000Z",
        exitCode: 1,
        signal: null,
      });
      const context = {
        input: {
          rootDir,
          repoId: "cancel-recovery-stopped",
          now: () => "2026-11-02T00:01:00.000Z",
        },
        requiredRuntimeProjection: () => ({
          readRuntimeSession: () => liveSession(runtimeSessionId),
          readDispatchLifecycle: dispatchLifecycleReadOf(() => [
            lifecycleEvent("R", runtimeSessionId, { dispatchId, instanceId: "instance-1", source: "local" }),
            lifecycleEvent("S", runtimeSessionId, { dispatchId, instanceId: "instance-1", source: "local" }),
          ]),
          readRuntimeSessions: () => [liveSession(runtimeSessionId)],
          readRuntimeDispatch: () => ({
            actor: binding.actor,
            source: "local",
            payload: { dispatchId, instanceId: "instance-1" },
          }),
          readRuntimeSessionEvents: () => [],
          readRuntimeSessionEventsByType: () => [
            { type: "runtime_session_liveness_changed", source: "local", payload: { processGroupPid: 2_147_483_647 } },
          ],
        }),
        processes: new Map(),
        exiting: new Set<string>(),
        publishRuntimeEvent: async (type: string) => {
          if (type === "runtime_session_liveness_changed")
            throw runtimeSpawnError("runtime_recovery_failed", "simulated adoption failure after process exit");
          published.push(type);
          return {};
        },
        controlReceipt: (_opId: string, _runtimeSessionId: string, detail: string) => ({ detail }),
        runtimeSpawnError,
      };
      const receipt = await cancelRuntime(context as never, { runtimeSessionId }, binding);
      assert.equal(receipt.detail, "cancelled");
      assert.deepEqual(published, [
        "runtime_session_exited",
        "runtime_session_cancelled",
        "runtime_session_outcome_observed",
      ]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  },
);

test(
  "cancelRuntime still fails when recovery fails while the process group remains alive",
  { skip: process.platform === "win32" ? "requires POSIX process-group probe semantics" : false },
  async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cancel-recovery-alive-"));
    const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    });
    const exited = once(child, "exit");
    await once(child, "spawn");
    try {
      const dispatchId = "dispatch_929292929292929292929292",
        runtimeSessionId = "runtime_929292929292929292929292",
        published: string[] = [];
      openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "cancel-recovery-alive");
      appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid: child.pid! });
      const context = {
        input: {
          rootDir,
          repoId: "cancel-recovery-alive",
          now: () => "2026-11-02T00:01:00.000Z",
        },
        requiredRuntimeProjection: () => ({
          readRuntimeSession: () => liveSession(runtimeSessionId),
          readDispatchLifecycle: dispatchLifecycleReadOf(() => [
            lifecycleEvent("R", runtimeSessionId, { dispatchId, instanceId: "instance-1", source: "local" }),
            lifecycleEvent("S", runtimeSessionId, { dispatchId, instanceId: "instance-1", source: "local" }),
          ]),
          readRuntimeSessions: () => [liveSession(runtimeSessionId)],
          readRuntimeDispatch: () => ({
            actor: binding.actor,
            source: "local",
            payload: { dispatchId, instanceId: "instance-1" },
          }),
          readRuntimeSessionEvents: () => [],
          readRuntimeSessionEventsByType: () => [
            { type: "runtime_session_liveness_changed", source: "local", payload: { processGroupPid: child.pid } },
          ],
        }),
        processes: new Map(),
        exiting: new Set<string>(),
        publishRuntimeEvent: async (type: string) => {
          if (type === "runtime_session_liveness_changed")
            throw runtimeSpawnError("runtime_recovery_failed", "simulated adoption failure while process alive");
          published.push(type);
          return {};
        },
        controlReceipt: (_opId: string, _runtimeSessionId: string, detail: string) => ({ detail }),
        runtimeSpawnError,
      };
      await assert.rejects(cancelRuntime(context as never, { runtimeSessionId }, binding), {
        code: "runtime_recovery_failed",
      });
      assert.deepEqual(published, []);
    } finally {
      child.stdin!.end();
      await exited;
      rmSync(rootDir, { recursive: true, force: true });
    }
  },
);

function openMissingProcessStream(
  rootDir: string,
  dispatchId: string,
  runtimeSessionId: string,
  dispatchOpId: string,
  task: { readonly taskId: string; readonly executionId: string } | null = null,
) {
  openDispatchStream(rootDir, {
    dispatchId,
    taskId: task?.taskId ?? null,
    executionId: task?.executionId ?? null,
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
