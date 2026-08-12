// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, makeTaskProjection } from "../../kernel/test/store/task-lifecycle-runtime.ts";

const actor = { principal: { personId: "person-1" }, executor: { kind: "agent" as const, id: "codex" } };
const otherActor = { principal: { personId: "person-2" }, executor: { kind: "agent" as const, id: "reviewer" } };

test("lease CAS permits only the current holder and version to renew and release", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-lease-"));
  try {
    git(rootDir, "init", "--quiet");
    git(rootDir, "config", "user.name", "Lease Test");
    git(rootDir, "config", "user.email", "lease-test@example.invalid");
    git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
    const projection = makeTaskProjection({ rootDir, eventStore: makeTaskEventStore({ rootDir }) });
    const reservation = projection.reserveLease({ schema: "lease/v1", taskId: "task-1", executionId: "execution-1", actor, source: "local",
      phase: "reserving", expiresAt: "2026-08-11T01:00:00.000Z", ttlMs: 1_800_000, version: 0 }, "2026-08-11T00:00:00.000Z");
    const active = projection.activateLease(reservation);

    assert.equal(active.phase, "active");
    assert.throws(() => projection.reserveLease({ ...reservation, executionId: "execution-2" }, "2026-08-11T00:00:00.000Z"), /conflict/u);
    assert.throws(() => projection.renewLease({ ...active, actor: otherActor }, "2026-08-11T02:00:00.000Z"), /stale/u);
    const renewed = projection.renewLease(active, "2026-08-11T02:00:00.000Z");
    assert.throws(() => projection.releaseLease(active), /stale/u);
    assert.equal(projection.releaseLease(renewed).phase, "released");
    assert.equal(projection.currentLease("task-1")?.phase, "released");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
