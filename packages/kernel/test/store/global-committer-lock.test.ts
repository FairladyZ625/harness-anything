import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { taskEntityId, type WriteError } from "../../src/domain/index.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { makeJournaledWriteCoordinator } from "../../src/store/index.ts";
import { docWrite, withTempStore, withTempStoreAsync } from "./helpers.ts";

const execFileAsync = promisify(execFile);

test("WriteCoordinator rejects semantic writes without document payload", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });

    const failure = runWriteFailure(coordinator.enqueue({
      opId: "op-transition",
      entityId: taskEntityId("task-1"),
      kind: "transition_local",
      payload: { to: "active" }
    }));

    assert.equal(failure._tag, "WriteRejected");
    assert.equal(failure.taskId, "task-1");
    assert.match(failure.reason, /requires path and body payload/);
    assert.equal(existsSync(path.join(rootDir, ".harness/write-journal/writes.jsonl")), false);
  });
});

test("WriteCoordinator validates supersede batch before writing any document", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });

    assert.throws(
      () => Effect.runSync(coordinator.enqueue({
        opId: "op-supersede-batch-invalid",
        entityId: taskEntityId("task-old"),
        kind: "package_supersede",
        payload: {
          writes: [
            { taskId: "task-old", path: "INDEX.md", body: "old archived", packageSlug: "old" },
            { taskId: "task-new", path: "/absolute.md", body: "new", packageSlug: "new" }
          ]
        }
      })),
      /absolute paths are not allowed/
    );
    assert.equal(existsSync(path.join(rootDir, ".harness/write-journal/writes.jsonl")), false);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-old-old/INDEX.md")), false);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-new-new/absolute.md")), false);
  });
});

test("WriteCoordinator validates package create batch before writing any document", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });

    assert.throws(
      () => Effect.runSync(coordinator.enqueue({
        opId: "op-create-batch-invalid",
        entityId: taskEntityId("task-new"),
        kind: "package_create",
        payload: {
          writes: [
            { taskId: "task-new", path: "INDEX.md", body: "index", packageSlug: "new" },
            { taskId: "task-new", path: "/absolute.md", body: "bad", packageSlug: "new" }
          ]
        }
      })),
      /absolute paths are not allowed/
    );
    assert.equal(existsSync(path.join(rootDir, ".harness/write-journal/writes.jsonl")), false);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-new-new/INDEX.md")), false);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-new-new/absolute.md")), false);
  });
});

test("WriteCoordinator rejects hard delete before journaling when policy payload or disposition is invalid", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });

    assert.throws(
      () => Effect.runSync(coordinator.enqueue({
        opId: "op-hard-delete-missing-reason",
        entityId: taskEntityId("task-hard"),
        kind: "package_delete_hard",
        payload: { reason: "" }
      })),
      /hard delete requires reason payload/
    );
    assert.equal(existsSync(path.join(rootDir, ".harness/write-journal/writes.jsonl")), false);

    mkdirSync(path.join(rootDir, "harness/tasks/task-hard"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/tasks/task-hard/INDEX.md"), [
      "---",
      "schema: task-package/v2",
      "task_id: task-hard",
      "title: Hard Delete",
      "lifecycle:",
      "  bindingSchema: lifecycle-binding/v1",
      "  engine: local",
      "  status: planned",
      "  ref: ",
      "  titleSnapshot: Hard Delete",
      "  url: ",
      "  bindingCreatedAt: 2026-06-12T00:00:00.000Z",
      "  bindingFingerprint: sha256:fixture",
      "packageDisposition: typo",
      "vertical: default",
      "preset: default",
      "---",
      ""
    ].join("\n"), "utf8");

    assert.throws(
      () => Effect.runSync(coordinator.enqueue({
        opId: "op-hard-delete-invalid-disposition",
        entityId: taskEntityId("task-hard"),
        kind: "package_delete_hard",
        payload: { reason: "mistaken local package" }
      })),
      /invalid package disposition/
    );
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-hard/INDEX.md")), true);
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

    const failure = runWriteFailure(blockedCoordinator.flush("explicit"));

    assert.equal(failure._tag, "GlobalWriteConflict");
    assert.equal(failure.owner, ".harness/locks/global.lock");
  });
});

test("entity lock conflicts preserve the scoped task id", () => {
  withTempStore((rootDir) => {
    mkdirSync(path.join(rootDir, ".harness/locks"), { recursive: true });
    writeFileSync(path.join(rootDir, `.harness/locks/entity-${sha256Text(taskEntityId("task-1"))}.lock`), JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      ownerToken: "held-by-live-task-owner"
    }), "utf8");

    const coordinator = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(coordinator.enqueue(docWrite("op-task-lock", "task-1", "blocked.md", "blocked")));

    const failure = runWriteFailure(coordinator.flush("explicit"));

    assert.equal(failure._tag, "WriteConflict");
    assert.equal(failure.taskId, "task-1");
    assert.equal(failure.owner, `.harness/locks/entity-${sha256Text(taskEntityId("task-1"))}.lock`);
  });
});

test("entity takeover claim conflicts preserve the scoped task id", () => {
  withTempStore((rootDir) => {
    const taskLockName = `entity-${sha256Text(taskEntityId("task-1"))}.lock`;
    mkdirSync(path.join(rootDir, ".harness/locks"), { recursive: true });
    writeFileSync(path.join(rootDir, `.harness/locks/${taskLockName}.takeover`), JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      ownerToken: "held-by-live-task-takeover",
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString()
    }), "utf8");

    const coordinator = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(coordinator.enqueue(docWrite("op-task-takeover", "task-1", "blocked.md", "blocked")));

    const failure = runWriteFailure(coordinator.flush("explicit"));

    assert.equal(failure._tag, "WriteConflict");
    assert.equal(failure.taskId, "task-1");
    assert.equal(failure.owner, taskLockName);
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

    const failure = runWriteFailure(coordinator.flush("explicit"));

    assert.equal(failure._tag, "GlobalWriteConflict");
    assert.equal(failure.owner, ".harness/locks/global.lock");
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

    const failure = runWriteFailure(coordinator.flush("explicit"));

    assert.equal(failure._tag, "GlobalWriteConflict");
    assert.equal(failure.owner, "global.lock");
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
      const result = Effect.runSync(Effect.either(coordinator.flush("explicit")));
      if (result._tag === "Left" && result.left._tag !== "GlobalWriteConflict") {
        throw new Error(JSON.stringify(result.left));
      }
    `;

    await Promise.all([
      execFileAsync(process.execPath, ["--input-type=module", "-e", childScript], { cwd: process.cwd() }),
      execFileAsync(process.execPath, ["--input-type=module", "-e", childScript], { cwd: process.cwd() })
    ]);

    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-1/race.md"), "utf8"), "second");
    assert.equal(readdirSync(path.join(rootDir, ".harness/locks")).length, 0);
    assert.deepEqual(
      readdirSync(path.join(rootDir, ".harness/write-journal")).filter((entry) => entry.includes(".stale.")),
      []
    );
  });
});

function runWriteFailure<A>(effect: Effect.Effect<A, WriteError>): WriteError {
  const result = Effect.runSync(Effect.either(effect));
  assert.equal(result._tag, "Left");
  if (result._tag !== "Left") {
    throw new Error("expected write effect to fail");
  }
  return result.left;
}
