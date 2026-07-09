import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  TaskClaimCollisionError,
  TaskLeaseRequiredError,
  makeTaskHolderService,
  type TaskHolderPrincipal,
  type TaskHolderRecord
} from "../src/index.ts";

const taskId = "task_01KX19GEKWMEJNGSMRT6JJH6HY";
const alice = { principalId: "alice", displayName: "Alice" } satisfies TaskHolderPrincipal;
const bob = { principalId: "bob", displayName: "Bob" } satisfies TaskHolderPrincipal;

test("claim collision exposes current holder and lease expiry", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-holder-"));
  try {
    const service = makeTaskHolderService({
      rootInput: rootDir,
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });

    await service.claim({ taskId, principal: alice, ttlMs: 60_000 });
    await assert.rejects(
      service.claim({ taskId, principal: bob, ttlMs: 60_000 }),
      (error) => {
        assert.equal(error instanceof TaskClaimCollisionError, true);
        const collision = error as TaskClaimCollisionError;
        assert.deepEqual(collision.holder, alice);
        assert.equal(collision.leaseExpiresAt, "2026-07-10T00:01:00.000Z");
        assert.match(collision.message, /alice/u);
        assert.match(collision.message, /2026-07-10T00:01:00.000Z/u);
        return true;
      }
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("expired lease is reported as task-holder orphan and can be reclaimed", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-holder-"));
  let now = new Date("2026-07-10T00:00:00.000Z");
  try {
    const service = makeTaskHolderService({ rootInput: rootDir, now: () => now });
    await service.claim({ taskId, principal: alice, ttlMs: 1_000 });

    now = new Date("2026-07-10T00:00:02.000Z");
    const orphan = await service.holder({ taskId });
    assert.equal(orphan.effectiveHolder, null);
    assert.equal(orphan.orphan, true);
    assert.equal(orphan.leaseExpiresAt, "2026-07-10T00:00:01.000Z");

    const reclaimed = await service.claim({ taskId, principal: bob, ttlMs: 1_000 });
    assert.deepEqual(reclaimed.effectiveHolder, bob);
    assert.equal(reclaimed.orphan, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("release frees the task for a new claim", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-holder-"));
  try {
    const service = makeTaskHolderService({
      rootInput: rootDir,
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });

    await service.claim({ taskId, principal: alice, ttlMs: 60_000 });
    const released = await service.release({ taskId, principal: alice });
    assert.deepEqual(released.previousHolder, alice);
    assert.equal(released.effectiveHolder, null);

    const claimed = await service.claim({ taskId, principal: bob, ttlMs: 60_000 });
    assert.deepEqual(claimed.effectiveHolder, bob);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("active lease assertion rejects non-holder and accepts holder", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-holder-"));
  try {
    const service = makeTaskHolderService({
      rootInput: rootDir,
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });

    await service.claim({ taskId, principal: alice, ttlMs: 60_000 });
    await service.assertActiveLease({ taskId, principal: alice });
    await assert.rejects(
      service.assertActiveLease({ taskId, principal: bob }),
      (error) => {
        assert.equal(error instanceof TaskLeaseRequiredError, true);
        const rejected = error as TaskLeaseRequiredError;
        assert.deepEqual(rejected.holder, alice);
        assert.equal(rejected.leaseExpiresAt, "2026-07-10T00:01:00.000Z");
        return true;
      }
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("holder record stays in local runtime state with acquiredVia claim", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-holder-"));
  try {
    const service = makeTaskHolderService({
      rootInput: rootDir,
      now: () => new Date("2026-07-10T00:00:00.000Z")
    });

    await service.claim({ taskId, principal: alice, ttlMs: 60_000 });
    const raw = readFileSync(path.join(rootDir, ".harness", "task-holders", `${taskId}.json`), "utf8");
    const record = JSON.parse(raw) as TaskHolderRecord;
    assert.equal(record.schema, "task-holder/v1");
    assert.equal(record.acquiredVia, "claim");
    assert.deepEqual(record.holder, alice);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
