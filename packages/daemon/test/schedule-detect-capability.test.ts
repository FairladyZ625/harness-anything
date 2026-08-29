// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertRuntimeScheduleCommandClass } from "../src/daemon-host-binding.ts";
import { openDispatchStream } from "../src/dispatch-stream.ts";

const actorFor = (runtimeSessionId: string) => ({
  principal: { personId: "schedule-runtime" },
  executor: { kind: "agent" as const, id: `runtime-session:${runtimeSessionId}` },
});

test("detect Schedule runtimes may read but cannot mutate canonical state or open a PR", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-detect-schedule-"));
  try {
    openScheduleStream(root, "runtime_detect", "detect");
    const actor = actorFor("runtime_detect");
    assert.doesNotThrow(() => assertRuntimeScheduleCommandClass(root, actor, "repo-read"));
    for (const commandClass of ["repo-write", "governance-write"] as const)
      assert.throws(
        () => assertRuntimeScheduleCommandClass(root, actor, commandClass),
        (error: unknown) => (error as { code?: string }).code === "rbac_forbidden",
        `${commandClass} must be rejected before it can reach canonical or PR mutation paths`,
      );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("remediate Schedule runtimes retain governed write command classes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-remediate-schedule-"));
  try {
    openScheduleStream(root, "runtime_remediate", "remediate");
    assert.doesNotThrow(() => assertRuntimeScheduleCommandClass(root, actorFor("runtime_remediate"), "repo-write"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function openScheduleStream(root: string, runtimeSessionId: string, mode: "detect" | "remediate"): void {
  openDispatchStream(root, {
    dispatchId: mode === "detect" ? "dispatch_111111111111111111111111" : "dispatch_222222222222222222222222",
    taskId: null,
    executionId: null,
    schedule: { scheduleId: `schedule-${mode}`, claimFence: `claim-${mode}`, mode },
    runtimeSessionId,
    instanceId: "codex-schedule",
    startedAt: "2026-08-29T00:00:00.000Z",
  });
}
