// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { e2eProbeIntervalMs, makeE2EProbeScheduler, resolveE2EProbeSchedule } from "../src/e2e-probe-scheduler.ts";
import type { RepoCell } from "../src/repo-cell.ts";

test("probe schedule is opt-in by declaration and defaults to enabled 2h Terra runs", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-e2e-probe-config-")),
    rootDir = path.join(parent, "repo");
  try {
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "harness", "harness.yaml"),
      "schema: harness-anything/v1\nsettings:\n  locale: en-US\n",
    );
    assert.equal(resolveE2EProbeSchedule(rootDir).enabled, false);
    writeFileSync(
      path.join(rootDir, "harness", "harness.yaml"),
      "schema: harness-anything/v1\nsettings:\n  e2eProbe:\n    every: 2h\n",
    );
    assert.deepEqual(resolveE2EProbeSchedule(rootDir), {
      enabled: true,
      intervalMs: e2eProbeIntervalMs,
      agentId: "e2e-probe",
      runtimeInstanceId: "test-codex-sol",
      model: "gpt-5.6-terra",
      effort: "low",
      source: "settings.e2eProbe",
      error: null,
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("daemon probe scheduler owns one timer, one in-flight run, and readable settled status", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-e2e-probe-scheduler-")),
    rootDir = path.join(parent, "repo"),
    timers: Array<{ callback: () => void; delayMs: number }> = [];
  let observedAt = "2026-08-26T00:00:00.000Z",
    spawnCount = 0;
  try {
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "harness", "harness.yaml"),
      "schema: harness-anything/v1\nsettings:\n  e2eProbe:\n    enabled: true\n    every: 2h\n",
    );
    const cell = {
        status: () => ({ rootDir }),
        spawnRuntime: async () => {
          spawnCount += 1;
          return { runtimeSessionId: "runtime-probe-one" };
        },
        read: async () => ({
          session: {
            runtimeSessionId: "runtime-probe-one",
            activity: { outcome: "succeeded", lastObservedAt: observedAt },
          },
          result: {
            text: JSON.stringify({
              schema: "e2e-probe-result/v1",
              outcome: "failed",
              failureSignature: "0123456789abcdef0123",
              taskId: "task-probe-failure",
              deduplicated: false,
            }),
          },
        }),
      } as unknown as RepoCell,
      scheduler = makeE2EProbeScheduler({
        cells: new Map([["alpha", cell]]),
        daemonRoute: { userRoot: "/daemon-user", daemonId: "default", endpoint: "/daemon.sock" },
        binding: { actor: { principal: { personId: "daemon-local-repair" }, executor: null }, source: "local" },
        now: () => observedAt,
        setTimer: (callback, delayMs) => {
          timers.push({ callback, delayMs });
          return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: () => undefined,
        nodeExecutable: "/node24",
      });
    await scheduler.start();
    assert.deepEqual(
      timers.map(({ delayMs }) => delayMs),
      [0],
    );
    timers.shift()?.callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(spawnCount, 1);
    assert.deepEqual(scheduler.status().running, {
      repoId: "alpha",
      runtimeSessionId: "runtime-probe-one",
      startedAt: observedAt,
    });

    observedAt = "2026-08-26T00:10:00.000Z";
    await scheduler.onRuntimeOutcome("alpha", {
      type: "runtime_session_outcome_observed",
      payload: { runtimeSessionId: "runtime-probe-one" },
    } as never);
    const status = scheduler.status();
    assert.equal(status.running, null);
    assert.equal(status.repos[0]?.lastRun?.probeOutcome, "failed");
    assert.equal(status.repos[0]?.lastRun?.taskId, "task-probe-failure");
    assert.equal(status.repos[0]?.nextRunAt, "2026-08-26T02:10:00.000Z");
    assert.equal(timers.at(-1)?.delayMs, e2eProbeIntervalMs);
    scheduler.close();
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
