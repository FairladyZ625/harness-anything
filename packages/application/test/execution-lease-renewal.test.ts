// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, makeTaskProjection } from "../../kernel/test/store/task-lifecycle-runtime.ts";
import { lifecycleHarness, owner } from "./task-lifecycle-test-harness.ts";

const actor = { principal: { personId: "person-1" }, executor: { kind: "agent" as const, id: "codex" } };
const otherActor = { principal: { personId: "person-2" }, executor: { kind: "agent" as const, id: "reviewer" } };

test("lease CAS permits only the current holder and version to renew and release", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-lease-"));
  let projection: ReturnType<typeof makeTaskProjection> | undefined;
  try {
    git(rootDir, "init", "--quiet");
    git(rootDir, "config", "user.name", "Lease Test");
    git(rootDir, "config", "user.email", "lease-test@example.invalid");
    git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
    projection = makeTaskProjection({ rootDir, eventStore: makeTaskEventStore({ repoId: "test-repo", rootDir }), now: () => "2026-08-11T00:30:00.000Z" });
    const reservation = projection.reserveLease({ schema: "lease/v1", taskId: "task-1", executionId: "execution-1", actor, source: "local",
      phase: "reserving", expiresAt: "2026-08-11T01:00:00.000Z", ttlMs: 1_800_000, version: 0 }, "2026-08-11T00:00:00.000Z");
    const active = projection.activateLease(reservation);

    assert.equal(active.phase, "held");
    assert.throws(() => projection.reserveLease({ ...reservation, executionId: "execution-2" }, "2026-08-11T00:00:00.000Z"), /conflict/u);
    assert.throws(() => projection.renewLease({ ...active, actor: otherActor }, "2026-08-11T02:00:00.000Z"), /stale/u);
    const renewed = projection.renewLease(active, "2026-08-11T02:00:00.000Z");
    assert.throws(() => projection.releaseLease(active), /stale/u);
    assert.equal(projection.releaseLease(renewed).phase, "released");
    assert.equal(projection.currentLease("task-1")?.phase, "released");
  } finally { projection?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("renewed lease survives database rebuild", async () => {
  const harness = lifecycleHarness();
  try {
    await harness.create();
    await harness.start("execution-1");
    const active = harness.projection.currentLease("task-1");
    if (active === null) throw new Error("fixture requires active lease");

    const renewed = await harness.service.renewLease({ taskId: "task-1", executionId: "execution-1", actor: owner,
      source: "local", expectedVersion: active.version, expiresAt: "2026-08-11T02:00:00.000Z",
      opId: "op-renew", eventId: "event-renew", workspaceRevision: 3, occurredAt: "2026-08-11T00:03:00.000Z" });

    assert.equal(renewed.version, active.version + 1);
    assert.equal(renewed.expiresAt, "2026-08-11T02:00:00.000Z");
    assert.equal(harness.eventStore.readEvent("op-renew")?.type, "lease_renewed");
  } finally { harness.cleanup(); }
});

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
