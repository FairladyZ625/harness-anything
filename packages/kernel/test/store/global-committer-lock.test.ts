// harness-test-tier: integration
import { testWriteAttribution } from "../test-attribution.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { taskEntityId, type WriteError } from "../../src/domain/index.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import type { VersionControlSystem } from "../../src/ports/index.ts";
import { makeJournaledWriteCoordinator } from "../../src/store/index.ts";
import { makeLocalVersionControlSystem } from "../../src/store/local-version-control-system.ts";
import { docWrite, runEffect, withTempStore, withTempStoreAsync } from "./helpers.ts";

const execFileAsync = promisify(execFile);

test("WriteCoordinator rejects semantic writes without document payload", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });

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
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });

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
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });

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

test("WriteCoordinator flush uses injected VCS port for git operations", () => {
  withTempStore((rootDir) => {
    const vcs = fakeVersionControlSystem(rootDir);
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir, versionControlSystem: vcs });

    Effect.runSync(coordinator.enqueue(docWrite("op-vcs-port", "task-1", "notes.md", "via fake vcs\n")));
    const report = Effect.runSync(coordinator.flush("manual"));
    const watermark = JSON.parse(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8")) as {
      readonly lastCommitSha: string;
    };

    assert.equal(report.committed, true);
    assert.equal(report.watermark, "op-vcs-port");
    assert.equal(watermark.lastCommitSha, "fake-head-1");
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-1/notes.md"), "utf8"), "via fake vcs\n");
  });
});

test("a commit failure leaves a durable apply marker that recovery automatically incorporates", () => {
  withTempStore((rootDir) => {
    const baseVcs = fakeVersionControlSystem(rootDir);
    let failCommit = true;
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(),
      rootDir,
      versionControlSystem: {
        ...baseVcs,
        commit: (repoRoot, message, author) => {
          if (failCommit) {
            failCommit = false;
            throw new Error("injected commit failure");
          }
          baseVcs.commit(repoRoot, message, author);
        }
      }
    });
    Effect.runSync(coordinator.enqueue(docWrite("op-commit-recovery", "task-recovery", "notes.md", "applied once\n")));

    const failure = runWriteFailure(coordinator.flush("explicit"));

    assert.equal(failure._tag, "JournalUnavailable");
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-recovery/notes.md"), "utf8"), "applied once\n");
    assert.match(readFileSync(path.join(rootDir, ".harness/write-journal/writes.jsonl"), "utf8"), /"schema":"apply-marker\/v1","opId":"op-commit-recovery"/u);

    const recovered = Effect.runSync(coordinator.recover);

    assert.equal(recovered.replayedOps, 1);
    assert.equal(recovered.recoveredWatermark, "op-commit-recovery");
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-recovery/notes.md"), "utf8"), "applied once\n");
  });
});

test("a post-watermark materializer failure cannot turn a committed write receipt into failure", () => {
  withTempStore((rootDir) => {
    const baseVcs = fakeVersionControlSystem(rootDir);
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(),
      rootDir,
      sessionId: "materializer-failure",
      versionControlSystem: {
        ...baseVcs,
        sessionBranches: () => {
          throw new Error("injected materializer failure");
        }
      }
    });
    Effect.runSync(coordinator.enqueue(docWrite("op-materializer-receipt", "task-materializer", "notes.md", "committed\n")));

    const report = Effect.runSync(coordinator.flush("explicit"));

    assert.equal(report.committed, true);
    assert.equal(report.watermark, "op-materializer-receipt");
    const watermark = JSON.parse(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8")) as {
      readonly lastCommittedOpIds: ReadonlyArray<string>;
    };
    assert.equal(watermark.lastCommittedOpIds.includes("op-materializer-receipt"), true);
  });
});

test("WriteCoordinator rejects hard delete before journaling when policy payload or disposition is invalid", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });

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
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });

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

    const blockedCoordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });
    Effect.runSync(blockedCoordinator.enqueue(docWrite("op-blocked", "task-1", "blocked.md", "blocked")));

    const failure = runWriteFailure(blockedCoordinator.flush("explicit"));

    assert.equal(failure._tag, "GlobalWriteConflict");
    assert.match(failure.owner ?? "", /\.harness\/locks\/global\.lock \(held by pid \d+ on /u);
  });
});

test("WriteCoordinator queues behind the global lock until the holder releases it", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const lockPath = path.join(rootDir, ".harness/locks/global.lock");
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      ownerToken: "short-lived-holder"
    }), "utf8");
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(),
      rootDir,
      lockConflictRetry: { maxWaitMs: 500, initialDelayMs: 10, maxDelayMs: 20 }
    });
    Effect.runSync(coordinator.enqueue(docWrite("op-queued", "task-queued", "queued.md", "queued\n")));
    setTimeout(() => rmSync(lockPath, { force: true }), 50);

    const report = await runEffect(coordinator.flush("explicit"));

    assert.equal(report.watermark, "op-queued");
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-queued/queued.md"), "utf8"), "queued\n");
  });
});

test("WriteCoordinator queues while a newly created lock record is still incomplete", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const lockPath = path.join(rootDir, ".harness/locks/global.lock");
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "", "utf8");
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(),
      rootDir,
      lockConflictRetry: { maxWaitMs: 500, initialDelayMs: 5, maxDelayMs: 20 }
    });
    Effect.runSync(coordinator.enqueue(docWrite("op-partial-lock", "task-partial", "queued.md", "queued\n")));
    setTimeout(() => rmSync(lockPath, { force: true }), 25);

    const report = await runEffect(coordinator.flush("explicit"));

    assert.equal(report.watermark, "op-partial-lock");
  });
});

test("WriteCoordinator lock queue times out with holder identity and recovery advice", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const lockPath = path.join(rootDir, ".harness/locks/global.lock");
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      ownerToken: "long-lived-holder"
    }), "utf8");
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(),
      rootDir,
      lockConflictRetry: { maxWaitMs: 30, initialDelayMs: 5, maxDelayMs: 10 }
    });
    Effect.runSync(coordinator.enqueue(docWrite("op-timeout", "task-timeout", "blocked.md", "blocked\n")));

    const result = await runEffect(Effect.either(coordinator.flush("explicit")));

    assert.equal(result._tag, "Left");
    if (result._tag !== "Left") throw new Error("expected lock timeout");
    assert.equal(result.left._tag, "GlobalWriteConflict");
    assert.match(result.left.owner ?? "", new RegExp(`held by pid ${process.pid} on ${hostname()}`, "u"));
    assert.match(result.left.owner ?? "", /timed out after 30ms/u);
    assert.match(result.left.owner ?? "", /retry the command or use the daemon-backed client/u);
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

    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });
    Effect.runSync(coordinator.enqueue(docWrite("op-task-lock", "task-1", "blocked.md", "blocked")));

    const failure = runWriteFailure(coordinator.flush("explicit"));

    assert.equal(failure._tag, "WriteConflict");
    assert.equal(failure.taskId, "task-1");
    assert.match(failure.owner ?? "", new RegExp(`^\\.harness/locks/entity-${sha256Text(taskEntityId("task-1"))}\\.lock \\(held by pid \\d+ on `, "u"));
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

    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });
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

    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir, lockTtlMs: 1 });
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

    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir, lockTtlMs: 1 });
    Effect.runSync(coordinator.enqueue(docWrite("op-live-lock", "task-1", "a.md", "a")));

    const failure = runWriteFailure(coordinator.flush("explicit"));

    assert.equal(failure._tag, "GlobalWriteConflict");
    assert.match(failure.owner ?? "", /\.harness\/locks\/global\.lock \(held by pid \d+ on /u);
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

    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir, lockTtlMs: 1 });
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

    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir, lockTtlMs: 1 });
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

    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir, lockTtlMs: 1 });
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
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir, lockTtlMs: 1 });
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
      const coordinator = makeJournaledWriteCoordinator({
        attribution: {
          actor: { principal: { kind: "person", personId: "person_test" }, executor: { kind: "agent", id: "test" } },
          principalSource: { kind: "local-configured", authority: "harness.yaml", authoritySha256: "sha256:test" },
          executorSource: "client-asserted"
        },
        rootDir: ${JSON.stringify(rootDir)},
        lockTtlMs: 1
      });
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

test("WriteCoordinator reserves code-doc-anchors.json for the dedicated operation", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(), rootDir });
    const genericFailure = runWriteFailure(coordinator.enqueue(docWrite("raw-code-doc", "task-1", "code-doc-anchors.json", "{}")));
    assert.equal(genericFailure._tag, "WriteRejected");
    assert.match(genericFailure.reason, /reserved machine document/u);
    assert.match(genericFailure.reason, /ha task code-doc reconcile task-1/u);

    const invalidDedicated = runWriteFailure(coordinator.enqueue({
      opId: "bad-code-doc",
      entityId: taskEntityId("task-1"),
      kind: "code_doc_reconcile",
      payload: { path: "code-doc-anchors.json", body: "{}" }
    }));
    assert.equal(invalidDedicated._tag, "WriteRejected");
    assert.match(invalidDedicated.reason, /schema code-doc-reconciliation\/v1/u);
  });
});

test("WriteCoordinator accepts validated dedicated code-doc writes", () => {
  withTempStore((rootDir) => {
    seedCodeDocTaskLedgers(rootDir);
    const local = makeLocalVersionControlSystem();
    const harnessRoot = path.join(rootDir, "harness");
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(),
      rootDir,
      versionControlSystem: {
        ...local,
        normalizePath: (inputPath) => path.resolve(inputPath),
        topLevel: (inputPath) => path.resolve(inputPath).startsWith(harnessRoot) ? harnessRoot : rootDir,
        isIgnored: () => false,
        commitExists: () => true,
        pathExistsAtCommit: () => true
      }
    });

    const ack = Effect.runSync(coordinator.enqueue({
      opId: "valid-code-doc",
      entityId: taskEntityId("task-1"),
      kind: "code_doc_reconcile",
      payload: { path: "code-doc-anchors.json", body: validCodeDocDocument() }
    }));

    assert.equal(ack.accepted, true);
  });
});

test("WriteCoordinator rejects task-tree staging with a hand-written code-doc file", () => {
  withTempStore((rootDir) => {
    seedCodeDocTaskLedgers(rootDir);
    const local = makeLocalVersionControlSystem();
    const harnessRoot = path.join(rootDir, "harness");
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(),
      rootDir,
      versionControlSystem: {
        ...local,
        normalizePath: (inputPath) => path.resolve(inputPath),
        topLevel: (inputPath) => path.resolve(inputPath).startsWith(harnessRoot) ? harnessRoot : rootDir,
        isIgnored: () => false,
        workingTreeFiles: () => "?? tasks/task-1/code-doc-anchors.json\n"
      }
    });

    const failure = runWriteFailure(coordinator.enqueue({
      opId: "stage-raw-code-doc",
      entityId: taskEntityId("task-1"),
      kind: "task_tree_stage",
      payload: { scope: "task-package" }
    }));

    assert.equal(failure._tag, "WriteRejected");
    assert.match(failure.reason, /do not write or stage it directly/u);
  });
});

function seedCodeDocTaskLedgers(rootDir: string): void {
  const taskRoot = path.join(rootDir, "harness/tasks/task-1");
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "closeout.md"), "# Closeout\n", "utf8");
}

function validCodeDocDocument(): string {
  return `${JSON.stringify({
    schema: "code-doc-reconciliation/v1",
    taskId: "task-1",
    records: [{
      id: "closeout",
      ledgerPath: "closeout.md",
      kind: "closeout",
      anchors: [{ kind: "path", sha: "0123456789abcdef0123456789abcdef01234567", path: "packages/kernel/src/index.ts" }]
    }]
  }, null, 2)}\n`;
}

function runWriteFailure<A>(effect: Effect.Effect<A, WriteError>): WriteError {
  const result = Effect.runSync(Effect.either(effect));
  assert.equal(result._tag, "Left");
  if (result._tag !== "Left") {
    throw new Error("expected write effect to fail");
  }
  return result.left;
}

function fakeVersionControlSystem(repoRoot: string): VersionControlSystem {
  let commitCount = 0;
  const harnessRoot = path.join(repoRoot, "harness");
  return {
    normalizePath: (inputPath) => path.resolve(inputPath),
    topLevel: (inputPath) => path.resolve(inputPath).startsWith(`${harnessRoot}${path.sep}`) || path.resolve(inputPath) === harnessRoot ? harnessRoot : repoRoot,
    isIgnored: () => false,
    add: () => undefined,
    workingTreeFiles: () => "",
    stagedFiles: () => "tasks/task-1/notes.md\n",
    commit: () => {
      commitCount += 1;
    },
    currentHead: () => `fake-head-${commitCount}`,
    currentBranch: () => "main",
    originHeadBranch: () => null,
    refExists: (_repoRoot, ref) => ref === "refs/heads/main" || ref === "main",
    commitExists: () => true,
    pathExistsAtCommit: () => true,
    checkout: () => undefined,
    createBranch: () => undefined,
    mergeNoFf: () => undefined,
    deleteBranch: () => undefined,
    abortMerge: () => undefined,
    sessionBranches: () => [],
    commitsNotInTrunk: () => [],
    changedFilesBetween: () => [],
    resetQuiet: () => undefined
  };
}
