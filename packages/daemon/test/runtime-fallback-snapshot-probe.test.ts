// harness-test-tier: fast
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtempSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDispatchStream, readDispatchStream } from "../src/daemon-host/dispatch-stream.ts";
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

test("closing the recovery writer during fallback continuation authorization does not exhaust the stream", async (t) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "fallback-daemon-closed-"));
  t.after(() => removeTempRepository(rootDir));
  const now = "2026-11-16T00:00:00.000Z",
    dispatchId = "dispatch_222222222222222222222222",
    provider = { instance: "provider-restart-first", model: "fixture", kind: "codex" },
    nextProvider = { ...provider, instance: "provider-restart-second" },
    binding = { actor: { principal: { personId: "owner" }, executor: null }, source: "local" } as const,
    writer = openDispatchStream(rootDir, {
      dispatchId,
      runtimeSessionId: "runtime_222222222222222222222222",
      taskId: "task-fixture",
      executionId: "execution-fixture",
      instanceId: provider.instance,
      startedAt: now,
      cwd: rootDir,
      binding,
      fallbackAttempt: {
        attemptGroupId: dispatchId,
        attemptIndex: 0,
        rootDispatchKey: "fixture-closed",
        originalMission: "Resume fallback after daemon restart.",
        candidates: [provider, nextProvider],
      },
    });
  writer.appendAttemptOutcome(
    {
      classification: "provider_quota",
      reason: "HTTP 429",
      provider,
      attemptGroupId: dispatchId,
      attemptIndex: 0,
    },
    now,
  );
  writer.appendTerminalOutcome(
    {
      reason: "HTTP 429",
      body: "quota exceeded",
      payload: {
        runtimeSessionId: "runtime_222222222222222222222222",
        outcome: "failed",
        endedAt: now,
        resultRef: "result-ref",
        result: null,
        reason: "HTTP 429",
        attempt: {
          attemptGroupId: dispatchId,
          attemptIndex: 0,
          rootDispatchKey: "fixture-closed",
          classification: "provider_quota",
          fallbackState: "scheduled",
          nextProvider,
          notBeforeAt: now,
        },
      },
    } as never,
    now,
  );
  const queued: Array<() => Promise<void>> = [];
  let closed = false,
    published = 0;
  const context = {
    closed: () => closed,
    publishRuntimeEvent: async () => {
      published += 1;
      throw Object.assign(new Error("Runtime recovery writer closed."), { code: "daemon_closed" });
    },
    input: {
      rootDir,
      now: () => now,
      schedule: (work: () => Promise<void>) => queued.push(work),
      authorizeRuntimeContinuation: async () => {
        closed = true;
        throw Object.assign(new Error("Runtime recovery writer closed."), { code: "daemon_closed" });
      },
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
        readTaskLifecycleNode: async () => "implementation",
      },
    },
  } as unknown as RuntimeSpawnerContext;
  let fire!: () => Promise<void>;
  const timer = t.mock.method(globalThis, "setTimeout", ((callback: () => Promise<void>) => {
    fire = callback;
    return { unref: () => undefined };
  }) as never);
  await scheduleFallbackContinuation({
    context,
    dispatchId,
    launch: async () => {
      assert.fail("launch must not run after authorization closes");
    },
  });
  timer.mock.restore();
  await assert.doesNotReject(fire());
  assert.equal(queued.length, 1);
  await assert.doesNotReject(queued[0]!());
  assert.equal(published, 0, "daemon_closed must not attempt terminal exhaustion publication");
  assert.equal(
    readDispatchStream(rootDir, dispatchId)?.terminalOutcome?.payload.attempt?.fallbackState,
    "scheduled",
    "shutdown during continuation authorization must preserve the scheduled fallback state for restart recovery",
  );
});
