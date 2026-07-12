// harness-test-tier: contract
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  TaskClaimCollisionError,
  TaskLeaseRequiredError,
  TaskReleaseNotHolderError,
  makeTaskHolderService,
  taskHolderActor,
  taskHolderExecutorFromJournalActor,
  type TaskHolderPrincipal,
  type TaskHolderRecord,
  type TaskHolderServiceOptions
} from "../src/index.ts";

const taskId = "task_01KX19GEKWMEJNGSMRT6JJH6HY";
const alice = taskHolderActor({ personId: "alice", displayName: "Alice" }, null) satisfies TaskHolderPrincipal;
const aliceCodex = taskHolderActor({ personId: "alice", displayName: "Alice" }, { kind: "agent", id: "codex" }) satisfies TaskHolderPrincipal;
const aliceClaude = taskHolderActor({ personId: "alice", displayName: "Alice" }, { kind: "agent", id: "claude-code" }) satisfies TaskHolderPrincipal;
const bob = taskHolderActor({ personId: "bob", displayName: "Bob" }, null) satisfies TaskHolderPrincipal;

test("independent task holder services atomically claim the same task", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-holder-race-"));
  const aliceWorker = startClaimWorker(rootDir, "alice");
  const bobWorker = startClaimWorker(rootDir, "bob");
  try {
    await Promise.all([aliceWorker.next(), bobWorker.next()]);
    const suffixes = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    for (const suffix of suffixes) {
      const racedTaskId = `task_01KX19GEKWMEJNGSMRT6JJH6H${suffix}`;
      aliceWorker.send(racedTaskId);
      bobWorker.send(racedTaskId);
      const results = await Promise.all([aliceWorker.next(), bobWorker.next()]);

      assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
      assert.deepEqual(
        results.filter((result) => !result.ok).map((result) => result.code),
        ["task_claim_collision"]
      );
    }
  } finally {
    aliceWorker.close();
    bobWorker.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

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
        assert.match(collision.message, /caller principal=bob, executor=none/u);
        assert.match(collision.message, /current holder principal=alice, executor=none/u);
        assert.match(collision.message, /lease status active/u);
        assert.match(collision.message, /2026-07-10T00:01:00.000Z/u);
        return true;
      }
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("same person with a different executor renews the lease instead of colliding", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-holder-"));
  let now = new Date("2026-07-10T00:00:00.000Z");
  try {
    const service = makeTaskHolderService({ rootInput: rootDir, now: () => now });

    await service.claim({ taskId, principal: aliceCodex, ttlMs: 60_000 });
    now = new Date("2026-07-10T00:00:10.000Z");
    const renewed = await service.claim({ taskId, principal: aliceClaude, ttlMs: 60_000 });

    assert.deepEqual(renewed.effectiveHolder, aliceClaude);
    assert.equal(renewed.leaseExpiresAt, "2026-07-10T00:01:10.000Z");
    assert.equal(renewed.orphan, false);
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

test("owner can release an orphaned lease while another principal is named and rejected", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-holder-"));
  let now = new Date("2026-07-10T00:00:00.000Z");
  try {
    const service = makeTaskHolderService({ rootInput: rootDir, now: () => now });
    await service.claim({ taskId, principal: aliceCodex, ttlMs: 1_000 });
    now = new Date("2026-07-10T00:00:02.000Z");

    await assert.rejects(service.release({ taskId, principal: bob }), (error) => {
      assert.equal(error instanceof TaskReleaseNotHolderError, true);
      const rejected = error as TaskReleaseNotHolderError;
      assert.deepEqual(rejected.holder, aliceCodex);
      assert.match(rejected.message, /caller principal=bob, executor=none/u);
      assert.match(rejected.message, /current holder principal=alice, executor=agent:codex/u);
      assert.match(rejected.message, /lease status orphaned, expired at 2026-07-10T00:00:01.000Z/u);
      return true;
    });

    const released = await service.release({ taskId, principal: aliceClaude });
    assert.deepEqual(released.previousHolder, aliceCodex);
    assert.equal(released.effectiveHolder, null);
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
        assert.match(rejected.message, /caller principal=bob, executor=none/u);
        assert.match(rejected.message, /current holder principal=alice, executor=none/u);
        return true;
      }
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a holder write refreshes the lease TTL", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-holder-"));
  let now = new Date("2026-07-10T00:00:00.000Z");
  try {
    const service = makeTaskHolderService({ rootInput: rootDir, now: () => now });
    await service.claim({ taskId, principal: aliceCodex, ttlMs: 60_000 });

    now = new Date("2026-07-10T00:00:10.000Z");
    await service.assertActiveLease({ taskId, principal: aliceCodex });

    const refreshed = await service.holder({ taskId });
    assert.equal(refreshed.leaseExpiresAt, "2026-07-10T00:01:10.000Z");
    assert.equal(refreshed.orphan, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a principal write recovers its orphaned lease and records the current executor", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-holder-"));
  let now = new Date("2026-07-10T00:00:00.000Z");
  try {
    const service = makeTaskHolderService({ rootInput: rootDir, now: () => now });
    await service.claim({ taskId, principal: aliceCodex, ttlMs: 60_000 });

    now = new Date("2026-07-10T00:02:00.000Z");
    await service.assertActiveLease({ taskId, principal: aliceClaude });

    const recovered = await service.holder({ taskId });
    assert.deepEqual(recovered.effectiveHolder, aliceClaude);
    assert.equal(recovered.leaseExpiresAt, "2026-07-10T00:03:00.000Z");
    assert.equal(recovered.orphan, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("missing lease error names the caller and reports no holder", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-holder-"));
  try {
    const service = makeTaskHolderService({ rootInput: rootDir });
    await assert.rejects(service.assertActiveLease({ taskId, principal: aliceCodex }), (error) => {
      const rejected = error as TaskLeaseRequiredError;
      assert.equal(rejected.holder, null);
      assert.match(rejected.message, /caller principal=alice, executor=agent:codex/u);
      assert.match(rejected.message, /current holder none; lease status none/u);
      assert.match(rejected.message, /claim the task before retrying/u);
      return true;
    });
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
    assert.equal(record.holder?.executor, null);
    assert.equal(record.holder?.responsibleHuman, "person:alice");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("execution lease transitions emit replayable envelopes without credential material", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-execution-lease-events-"));
  type LeaseEvent = Parameters<NonNullable<TaskHolderServiceOptions["appendLeaseEvent"]>>[0];
  const events: LeaseEvent[] = [];
  let now = new Date("2026-07-10T00:00:00.000Z");
  try {
    const service = makeTaskHolderService({
      rootInput: rootDir,
      now: () => now,
      appendLeaseEvent: async (event) => { events.push(event); }
    });
    const reserved = await service.reserveExecution({ taskId, executionId: "exe_lease_events_01", principal: aliceCodex, ttlMs: 1_000 });
    await service.activateExecution({
      taskId,
      executionId: reserved.executionId,
      leaseToken: reserved.leaseToken,
      principal: aliceCodex
    });
    await service.releaseExecution({
      taskId,
      executionId: reserved.executionId,
      leaseToken: reserved.leaseToken,
      principal: aliceCodex
    });

    assert.deepEqual(events.map((event) => event.lease.action), ["reserved", "activated", "released"]);
    assert.equal(events[0]?.lease.leaseExpiresAt, "2026-07-10T00:00:01.000Z");
    assert.deepEqual(events[2]?.lease.previousHolder, {
      principal: { kind: "person", personId: "alice" },
      executor: { kind: "agent", id: "codex" }
    });
    assert.doesNotMatch(JSON.stringify(events), /token|hash|credential/iu);

    const expiring = await service.reserveExecution({ taskId, executionId: "exe_lease_events_02", principal: aliceCodex, ttlMs: 1_000 });
    now = new Date("2026-07-10T00:00:02.000Z");
    await service.reconcileExecution({ taskId, executionId: expiring.executionId, authoredState: "active" });
    assert.equal(events.at(-1)?.lease.action, "expired");
    assert.equal(events.at(-1)?.lease.phase, "expired");
    assert.equal((await service.holder({ taskId })).orphan, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("system journal actors cannot be projected as direct-human lease executors", () => {
  assert.throws(
    () => taskHolderExecutorFromJournalActor({ kind: "system", id: "cron" }),
    /use an agent executor with a person principal/u
  );
});

interface ClaimWorkerMessage {
  readonly ready?: boolean;
  readonly taskId?: string;
  readonly ok?: boolean;
  readonly code?: string;
}

function startClaimWorker(rootDir: string, personId: string): {
  readonly send: (taskId: string) => void;
  readonly next: () => Promise<ClaimWorkerMessage>;
  readonly close: () => void;
} {
  const workerPath = fileURLToPath(new URL("./fixtures/task-holder-claim-worker.ts", import.meta.url));
  const child = spawn(process.execPath, [workerPath, rootDir, personId], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  const iterator = lines[Symbol.asyncIterator]();
  return {
    send: (taskId) => child.stdin.write(`${JSON.stringify({ taskId })}\n`),
    next: async () => {
      const result = await iterator.next();
      if (!result.done) return JSON.parse(result.value) as ClaimWorkerMessage;
      throw workerExitError(child, lines);
    },
    close: () => {
      lines.close();
      child.kill();
    }
  };
}

function workerExitError(process: ChildProcessWithoutNullStreams, lines: Interface): Error {
  lines.close();
  return new Error(`task-holder claim worker exited before responding (exitCode=${process.exitCode ?? "running"})`);
}
