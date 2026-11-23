// harness-test-tier: fast
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDispatchStream } from "../src/daemon-host/dispatch-stream.ts";
import { scheduleFallbackContinuation } from "../src/daemon-host/runtime-spawn-fallback.ts";
import type { RuntimeSpawnerContext } from "../src/daemon-host/runtime-spawn-context.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

for (const failedProbe of ["git", "replica"] as const)
  test(`fallback still launches with unavailable context when the ${failedProbe} probe rejects`, async (t) => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "fallback-snapshot-probe-"));
    t.after(() => removeTempRepository(rootDir));
    const now = "2026-11-16T00:00:00.000Z",
      dispatchId = "dispatch_111111111111111111111111",
      provider = { instance: "first", model: "fixture", kind: "codex" },
      nextProvider = { ...provider, instance: "second" },
      binding = { actor: { principal: { personId: "owner" }, executor: null }, source: "local" } as const,
      writer = openDispatchStream(rootDir, {
        dispatchId,
        runtimeSessionId: "runtime_111111111111111111111111",
        taskId: "task-fixture",
        executionId: "execution-fixture",
        instanceId: provider.instance,
        startedAt: now,
        cwd: rootDir,
        binding,
        fallbackAttempt: {
          attemptGroupId: dispatchId,
          attemptIndex: 0,
          rootDispatchKey: "fixture",
          originalMission: "Continue the task.",
          candidates: [provider, nextProvider],
        },
      });
    writer.appendAttemptOutcome(
      {
        classification: "provider_fault",
        reason: "startup 500",
        provider,
        attemptGroupId: dispatchId,
        attemptIndex: 0,
      },
      now,
    );
    const queued: Array<() => Promise<void>> = [],
      prompts: string[] = [],
      context = {
        input: {
          rootDir,
          now: () => now,
          schedule: (work: () => Promise<void>) => queued.push(work),
          remote: {
            readDispatchLifecycle: async () => ({
              status: "ready",
              rows: [
                {
                  policy: { fallbackPending: true },
                  controlLeafDispatchId: dispatchId,
                  successor: { schedule: { notBeforeAt: now, nextProvider } },
                },
              ],
            }),
            readTaskLifecycleNode: async () => {
              if (failedProbe === "replica")
                throw Object.assign(new Error("replica unavailable"), { code: "replica_unavailable" });
              return "implementation";
            },
          },
        },
      } as unknown as RuntimeSpawnerContext;
    // Capture the real timer callback, then await it explicitly: no wall-clock sleeps or
    // unhandled rejections, including in the red control before the fix.
    let fire!: () => Promise<void>;
    const timer = t.mock.method(globalThis, "setTimeout", ((callback: () => Promise<void>) => {
      fire = callback;
      return { unref: () => undefined };
    }) as never);
    await scheduleFallbackContinuation({
      context,
      dispatchId,
      launch: async (payload) => {
        prompts.push(String(payload.prompt));
        return {};
      },
    });
    timer.mock.restore();
    if (failedProbe === "git") {
      t.mock.method(childProcess, "execFile", () => {
        throw Object.assign(new Error("git denied"), { code: "EACCES" });
      });
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });
    }
    await assert.doesNotReject(fire());
    assert.equal(queued.length, 1, "snapshot failure must not drop the scheduled fallback");
    await queued[0]!();
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /Workspace probe: .*unavailable/u);
    assert.ok(prompts[0]!.endsWith("Continue the task."));
    const snapshot = prompts[0]!.match(/<runtime-progress>[\s\S]*?<\/runtime-progress>/u)![0];
    assert.ok(Buffer.byteLength(snapshot, "utf8") <= 2048);
    if (failedProbe === "git") assert.match(snapshot, /Changed files: unavailable/u);
    else assert.match(snapshot, /Task lifecycle node: unavailable/u);
  });
