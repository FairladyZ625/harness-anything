// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeJournaledWriteCoordinator } from "../../kernel/src/index.ts";
import { makeTaskLeaseStore, TaskLeaseConflictError } from "../../kernel/test/store/task-lifecycle-runtime.ts";
import { runTaskLifecycleEffect } from "../src/task-lifecycle-service.ts";

const actor = { principal: { personId: "person-1" }, executor: { kind: "agent" as const, id: "codex" } };
const otherActor = { principal: { personId: "person-2" }, executor: { kind: "agent" as const, id: "reviewer" } };

test("lease CAS permits only the current holder to renew and release", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-lease-"));
  try {
    const leases = makeTaskLeaseStore({ rootDir, coordinator: makeJournaledWriteCoordinator({ rootDir }), runEffect: runTaskLifecycleEffect, now: () => "2026-08-11T00:00:00.000Z" });
    const reservation = await leases.reserve({
      taskId: "task-1", executionId: "execution-1", actor,
      expiresAt: "2026-08-11T01:00:00.000Z"
    });
    const active = await leases.activate({ taskId: "task-1", executionId: "execution-1", actor, version: reservation.version });

    assert.equal(active.phase, "active");
    await assert.rejects(leases.reserve({
      taskId: "task-1", executionId: "execution-2", actor,
      expiresAt: "2026-08-11T02:00:00.000Z"
    }), TaskLeaseConflictError);
    await assert.rejects(leases.renew({
      taskId: "task-1", executionId: "execution-1", actor: otherActor, version: active.version,
      expiresAt: "2026-08-11T02:00:00.000Z"
    }), TaskLeaseConflictError);
    const renewed = await leases.renew({
      taskId: "task-1", executionId: "execution-1", actor, version: active.version,
      expiresAt: "2026-08-11T02:00:00.000Z"
    });
    await assert.rejects(leases.release({
      taskId: "task-1", executionId: "execution-1", actor, version: active.version
    }), TaskLeaseConflictError);
    assert.equal((await leases.release({
      taskId: "task-1", executionId: "execution-1", actor, version: renewed.version
    })).phase, "released");
    assert.equal(leases.current("task-1"), null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
