// harness-test-tier: fast
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import workerThreads from "node:worker_threads";
import { attachActiveRuntime, disposeActiveRuntimeObservations } from "../src/runtime-spawn-active.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import { active, tasklessSettlementRuntime } from "./runtime-spawn-settlement.fixtures.ts";

for (const ordering of ["fault-before-exit", "exit-before-fault"] as const) {
  for (const channel of ["worker-error", "observation-record"] as const) {
    test(`workspace ${channel} survives ${ordering} before settlement`, { timeout: 30_000 }, async (t) => {
      const root = mkdtempSync(path.join(tmpdir(), "ha-watch-exit-race-")),
        cwd = path.join(root, "workspace"),
        scheduled: Array<() => void | Promise<void>> = [],
        published = Promise.withResolvers<{ code: number | null; error: unknown; reason: string | null }>();
      mkdirSync(cwd);
      let onExit: ((code: number | null) => void) | undefined, nextWork: (() => void) | undefined;
      const worker = Object.assign(new EventEmitter(), {
        unref: () => undefined,
        terminate: async () => 1,
        postMessage: () => undefined,
      });
      t.mock.method(workerThreads, "Worker", function FakeWorker() {
        return worker;
      } as unknown as typeof workerThreads.Worker);
      syncBuiltinESMExports();
      const base = tasklessSettlementRuntime(cwd, null),
        runtime = active({
          ...base,
          process: {
            ...base.process,
            onExit: (listener) => {
              onExit = listener;
            },
            terminate: () => assert.fail("an already exited provider must not be terminated"),
          },
        }),
        context = {
          input: {
            rootDir: root,
            now: () => new Date().toISOString(),
            schedule: (work: () => void | Promise<void>) => {
              scheduled.push(work);
              nextWork?.();
              nextWork = undefined;
            },
          },
          processes: new Map([[runtime.runtimeSessionId, runtime]]),
          exiting: new Set(),
          consumeChunk: async () => undefined,
          publishExit: async (_active: unknown, code: number | null) => {
            published.resolve({ code, error: runtime.observationError, reason: runtime.lossReason });
          },
        } as unknown as RuntimeSpawnerContext;
      try {
        attachActiveRuntime(context, runtime);
        const fault = Object.assign(new Error("watch permission denied"), { code: "EACCES" });
        const emitFault = () => {
          if (channel === "worker-error") worker.emit("error", fault);
          else
            worker.emit("message", { kind: "workspace_observation_failed", code: fault.code, message: fault.message });
        };
        if (ordering === "fault-before-exit") emitFault();
        onExit!(0);
        if (ordering === "exit-before-fault") emitFault();
        worker.emit("exit", 0);
        let complete = false;
        void published.promise.then(() => (complete = true));
        while (!complete) {
          if (scheduled.length > 0) {
            try {
              await scheduled.shift()!();
            } catch (error) {
              assert.equal((error as NodeJS.ErrnoException).code, "EACCES");
            }
          } else await Promise.race([new Promise<void>((resolve) => (nextWork = resolve)), published.promise]);
        }
        const result = await published.promise;
        assert.equal((result.error as NodeJS.ErrnoException | undefined)?.code, "EACCES");
        assert.match(result.reason ?? "", /EACCES.*watch permission denied/u);
      } finally {
        disposeActiveRuntimeObservations(runtime);
        t.mock.restoreAll();
        syncBuiltinESMExports();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
