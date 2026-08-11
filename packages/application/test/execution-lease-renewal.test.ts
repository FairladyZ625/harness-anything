// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskLeaseStore, TaskLeaseConflictError } from "../../kernel/test/store/task-lifecycle-runtime.ts";

const actor = { principal: { personId: "person-1" }, executor: { kind: "agent" as const, id: "codex" } };

test("lease CAS permits only the current holder to renew and release", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-lease-"));
  try {
    const leases = makeTaskLeaseStore({ rootDir, now: () => "2026-08-11T00:00:00.000Z" });
    const reservation = leases.reserve({
      taskId: "task-1", executionId: "execution-1", actor, credentialHash: "hash-1",
      expiresAt: "2026-08-11T01:00:00.000Z"
    });
    const active = leases.activate({ taskId: "task-1", executionId: "execution-1", credentialHash: "hash-1", version: reservation.version });

    assert.equal(active.phase, "active");
    assert.throws(() => leases.reserve({
      taskId: "task-1", executionId: "execution-2", actor, credentialHash: "hash-2",
      expiresAt: "2026-08-11T02:00:00.000Z"
    }), TaskLeaseConflictError);
    assert.throws(() => leases.renew({
      taskId: "task-1", executionId: "execution-1", credentialHash: "stale", version: active.version,
      expiresAt: "2026-08-11T02:00:00.000Z"
    }), TaskLeaseConflictError);
    const renewed = leases.renew({
      taskId: "task-1", executionId: "execution-1", credentialHash: "hash-1", version: active.version,
      expiresAt: "2026-08-11T02:00:00.000Z"
    });
    assert.throws(() => leases.release({
      taskId: "task-1", executionId: "execution-1", credentialHash: "hash-1", version: active.version
    }), TaskLeaseConflictError);
    assert.equal(leases.release({
      taskId: "task-1", executionId: "execution-1", credentialHash: "hash-1", version: renewed.version
    }).phase, "released");
    assert.equal(leases.current("task-1"), null);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
