import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { makeJournaledWriteCoordinator } from "../../src/store/index.ts";
import { docWrite, withTempStore, withTempStoreAsync } from "./helpers.ts";

const execFileAsync = promisify(execFile);

test("WriteCoordinator rejects unsupported non-document writes before lifecycle exists", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });

    Effect.runSync(coordinator.enqueue({
      opId: "op-transition",
      taskId: "task-1",
      kind: "transition_local",
      payload: { to: "active" }
    }));

    assert.throws(
      () => Effect.runSync(coordinator.flush("explicit")),
      /unsupported write op kind/
    );
  });
});

test("WriteCoordinator keeps independent task writes in one global commit stream", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });

    Effect.runSync(coordinator.enqueue(docWrite("op-1", "task-1", "a.md", "a")));
    Effect.runSync(coordinator.enqueue(docWrite("op-2", "task-2", "b.md", "b")));

    const report = Effect.runSync(coordinator.flush("explicit"));
    assert.equal(report.opCount, 2);
    assert.equal(report.watermark, "op-2");
  });
});

test("two coordinators cannot flush while the global lock is already held", () => {
  withTempStore((rootDir) => {
    mkdirSync(path.join(rootDir, ".harness/locks"), { recursive: true });
    writeFileSync(path.join(rootDir, ".harness/locks/global.lock"), JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      ownerToken: "held-by-live-process"
    }), "utf8");

    const blockedCoordinator = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(blockedCoordinator.enqueue(docWrite("op-blocked", "task-1", "blocked.md", "blocked")));

    assert.throws(
      () => Effect.runSync(blockedCoordinator.flush("explicit")),
      /lock already held/
    );
  });
});

test("stale lock takeover is journaled before continuing", () => {
  withTempStore((rootDir) => {
    mkdirSync(path.join(rootDir, ".harness/locks"), { recursive: true });
    writeFileSync(path.join(rootDir, ".harness/locks/global.lock"), JSON.stringify({
      pid: 999_999_999,
      hostname: hostname(),
      acquiredAt: "2000-01-01T00:00:00.000Z",
      heartbeatAt: "2000-01-01T00:00:00.000Z",
      ownerToken: "dead-owner"
    }), "utf8");

    const coordinator = makeJournaledWriteCoordinator({ rootDir, lockTtlMs: 1 });
    Effect.runSync(coordinator.enqueue(docWrite("op-after-stale-lock", "task-1", "a.md", "a")));
    const report = Effect.runSync(coordinator.flush("explicit"));

    assert.equal(report.opCount, 1);
    assert.match(readFileSync(path.join(rootDir, ".harness/write-journal/writes.jsonl"), "utf8"), /"schema":"lock-takeover\/v1"/);
  });
});

test("live process locks are not taken over solely because TTL expired", () => {
  withTempStore((rootDir) => {
    mkdirSync(path.join(rootDir, ".harness/locks"), { recursive: true });
    writeFileSync(path.join(rootDir, ".harness/locks/global.lock"), JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: "2000-01-01T00:00:00.000Z",
      heartbeatAt: "2000-01-01T00:00:00.000Z",
      ownerToken: "still-live-owner"
    }), "utf8");

    const coordinator = makeJournaledWriteCoordinator({ rootDir, lockTtlMs: 1 });
    Effect.runSync(coordinator.enqueue(docWrite("op-live-lock", "task-1", "a.md", "a")));

    assert.throws(
      () => Effect.runSync(coordinator.flush("explicit")),
      /lock already held/
    );
    assert.equal(
      JSON.parse(readFileSync(path.join(rootDir, ".harness/locks/global.lock"), "utf8")).ownerToken,
      "still-live-owner"
    );
  });
});

test("takeover claim prevents silent acquire while stale lock is quarantined", () => {
  withTempStore((rootDir) => {
    mkdirSync(path.join(rootDir, ".harness/locks"), { recursive: true });
    writeFileSync(path.join(rootDir, ".harness/locks/global.lock.takeover"), JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      ownerToken: "takeover-owner",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString()
    }), "utf8");

    const coordinator = makeJournaledWriteCoordinator({ rootDir, lockTtlMs: 1 });
    Effect.runSync(coordinator.enqueue(docWrite("op-claim", "task-1", "a.md", "a")));

    assert.throws(
      () => Effect.runSync(coordinator.flush("explicit")),
      /takeover in progress|lock already held/
    );
    assert.throws(
      () => readFileSync(path.join(rootDir, ".harness/locks/global.lock"), "utf8"),
      /ENOENT/
    );
  });
});

test("dead takeover claim is cleared so stale lock recovery can continue", () => {
  withTempStore((rootDir) => {
    mkdirSync(path.join(rootDir, ".harness/locks"), { recursive: true });
    writeFileSync(path.join(rootDir, ".harness/locks/global.lock"), JSON.stringify({
      pid: 999_999_998,
      hostname: hostname(),
      acquiredAt: "2000-01-01T00:00:00.000Z",
      heartbeatAt: "2000-01-01T00:00:00.000Z",
      ownerToken: "dead-lock-owner"
    }), "utf8");
    writeFileSync(path.join(rootDir, ".harness/locks/global.lock.takeover"), JSON.stringify({
      pid: 999_999_999,
      hostname: hostname(),
      ownerToken: "dead-takeover-owner",
      acquiredAt: "2000-01-01T00:00:00.000Z",
      heartbeatAt: "2000-01-01T00:00:00.000Z"
    }), "utf8");

    const coordinator = makeJournaledWriteCoordinator({ rootDir, lockTtlMs: 1 });
    Effect.runSync(coordinator.enqueue(docWrite("op-dead-claim", "task-1", "a.md", "a")));
    const report = Effect.runSync(coordinator.flush("explicit"));

    assert.equal(report.opCount, 1);
    assert.throws(
      () => readFileSync(path.join(rootDir, ".harness/locks/global.lock.takeover"), "utf8"),
      /ENOENT/
    );
  });
});

test("quarantined stale lock is restored before takeover is journaled", () => {
  withTempStore((rootDir) => {
    mkdirSync(path.join(rootDir, ".harness/locks"), { recursive: true });
    writeFileSync(path.join(rootDir, ".harness/locks/global.lock.stale.dead-lock-owner.dead-takeover-owner"), JSON.stringify({
      pid: 999_999_998,
      hostname: hostname(),
      acquiredAt: "2000-01-01T00:00:00.000Z",
      heartbeatAt: "2000-01-01T00:00:00.000Z",
      ownerToken: "dead-lock-owner"
    }), "utf8");
    writeFileSync(path.join(rootDir, ".harness/locks/global.lock.takeover"), JSON.stringify({
      pid: 999_999_999,
      hostname: hostname(),
      ownerToken: "dead-takeover-owner",
      acquiredAt: "2000-01-01T00:00:00.000Z",
      heartbeatAt: "2000-01-01T00:00:00.000Z"
    }), "utf8");

    const coordinator = makeJournaledWriteCoordinator({ rootDir, lockTtlMs: 1 });
    Effect.runSync(coordinator.enqueue(docWrite("op-quarantine", "task-1", "a.md", "a")));
    const report = Effect.runSync(coordinator.flush("explicit"));

    assert.equal(report.opCount, 1);
    assert.match(readFileSync(path.join(rootDir, ".harness/write-journal/writes.jsonl"), "utf8"), /"schema":"lock-takeover\/v1"/);
    assert.deepEqual(
      readdirSync(path.join(rootDir, ".harness/locks")).filter((entry) => entry.includes(".stale.")),
      []
    );
  });
});

test("double stale lock takeover race keeps a single committer", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir, lockTtlMs: 1 });
    Effect.runSync(coordinator.enqueue(docWrite("op-race-1", "task-1", "race.md", "first")));
    Effect.runSync(coordinator.enqueue(docWrite("op-race-2", "task-1", "race.md", "second")));

    mkdirSync(path.join(rootDir, ".harness/locks"), { recursive: true });
    writeFileSync(path.join(rootDir, ".harness/locks/global.lock"), JSON.stringify({
      pid: 999_999_999,
      hostname: hostname(),
      acquiredAt: "2000-01-01T00:00:00.000Z",
      heartbeatAt: "2000-01-01T00:00:00.000Z",
      ownerToken: "dead-owner-race"
    }), "utf8");

    const childScript = `
      import { Effect } from "effect";
      import { makeJournaledWriteCoordinator } from "./packages/kernel/src/store/index.ts";
      const coordinator = makeJournaledWriteCoordinator({ rootDir: ${JSON.stringify(rootDir)}, lockTtlMs: 1 });
      try {
        Effect.runSync(coordinator.flush("explicit"));
      } catch (error) {
        if (!String(error).includes("lock already held")) throw error;
      }
    `;

    await Promise.all([
      execFileAsync(process.execPath, ["--input-type=module", "-e", childScript], { cwd: process.cwd() }),
      execFileAsync(process.execPath, ["--input-type=module", "-e", childScript], { cwd: process.cwd() })
    ]);

    assert.equal(readFileSync(path.join(rootDir, "harness/planning/tasks/task-1/race.md"), "utf8"), "second");
    assert.equal(readdirSync(path.join(rootDir, ".harness/locks")).length, 0);
    assert.deepEqual(
      readdirSync(path.join(rootDir, ".harness/write-journal")).filter((entry) => entry.includes(".stale.")),
      []
    );
  });
});
