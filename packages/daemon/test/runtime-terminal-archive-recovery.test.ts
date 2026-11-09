// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { adoptRuntimes } from "../src/runtime-spawn-adoption.ts";
import { appendRuntimeWorkerRecord, dispatchStreamPath, openDispatchStream } from "../src/dispatch-stream.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import { lifecycleReadFor } from "./dispatch-lifecycle-read.fixtures.ts";

for (const state of ["dead", "alive", "foreign", "fallback"] as const) {
  test(`terminal archive reconciliation is idempotent and preserves ${state} ownership`, async (t) => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "terminal-archive-recovery-"));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const dispatchId = "dispatch_111111111111111111111111",
      runtimeSessionId = "runtime-terminal-archive",
      binding = { actor: { principal: { personId: "owner" }, executor: null }, source: "local" as const },
      stream = openDispatchStream(rootDir, {
        dispatchId,
        runtimeSessionId,
        taskId: "done-task",
        executionId: "done-execution",
        instanceId: "instance",
        startedAt: "2026-11-01T00:00:00.000Z",
        dispatchOpId: dispatchId,
        kindId: "codex",
        permissionMode: "read-only",
        cwd: rootDir,
        binding,
        prompt: "recover",
        model: "test",
        reasoningEffort: null,
      });
    appendRuntimeWorkerRecord(rootDir, dispatchId, {
      kind: "process_started",
      pid: state === "alive" ? process.pid : 2_147_483_647,
    });
    if (state === "fallback")
      stream.appendFallbackState(
        { state: "scheduled", delayMs: 1, notBeforeAt: "2026-11-01T00:01:00.000Z", nextProvider: { instance: "next" } },
        "2026-11-01T00:00:01.000Z",
      );
    const context = {
      input: { rootDir, now: () => "2026-11-01T00:01:00.000Z" },
      processes: new Map(),
      exiting: new Set(),
      requiredRuntimeProjection: () => ({
        readRuntimeSessions: () => [
          { runtimeSessionId, instanceId: "instance", outcome: "succeeded", liveness: "exited" },
        ],
        readRuntimeDispatch: () => ({
          ...binding,
          source: state === "foreign" ? { kind: "node", nodeId: "other" } : "local",
          payload: { dispatchId },
        }),
        readDispatchLifecycle: lifecycleReadFor([
          {
            runtimeSessionId,
            dispatchId,
            instanceId: "instance",
            attemptSettled: true,
            groupSettled: true,
          },
        ]),
      }),
      publishExit: () => {
        throw new Error("canonical terminal must not settle the task again");
      },
      runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    } as unknown as RuntimeSpawnerContext;
    await adoptRuntimes(context);
    const firstPath = dispatchStreamPath(rootDir, dispatchId);
    assert.equal(path.basename(path.dirname(firstPath!)), state === "dead" ? "archive" : "dispatches");
    await adoptRuntimes(context);
    assert.equal(dispatchStreamPath(rootDir, dispatchId), firstPath);
    assert.equal(context.processes.size, 0);
  });
}
