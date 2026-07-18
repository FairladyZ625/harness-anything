// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { createDaemonRuntime } from "../../../adapters/local/src/index.ts";
import { moduleEntityId } from "../../src/domain/index.ts";
import { makeJournaledWriteCoordinator, makeOperationalJournaledWriteCoordinator } from "../../src/store/index.ts";
import { docWrite, runEffect, withTempStoreAsync } from "./helpers.ts";
import { daemonAttribution, git, initAuthoredGit } from "./helpers/daemon-runtime.ts";

const testAttribution = daemonAttribution("person_test", "test", "credential-test");

test("daemon serializes authority and runtime-event flush domains before either enters the durable journal", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initAuthoredGit(rootDir);
    const runtime = createDaemonRuntime({ rootDir, materializerPollMs: false, interactiveMicroBatchMs: 20 });
    await runtime.start();
    const authority = runtime.createAttributedCoordinator({ attribution: testAttribution, sessionId: "authority-domain" });
    Effect.runSync(authority.enqueue({
      ...docWrite("op-authority-domain", "task-authority-domain", "note.md", "authority\n"),
      authorityIntegrity: authorityIntegrity("11", "22", "33", "task-authority-domain")
    }));
    const runtimeEventReceipt = await runtime.enqueueInteractiveWrite({
      commandId: "runtime-event-domain",
      operationalActor: { scope: "operational", kind: "system", id: "daemon-runtime" },
      ops: [runtimeEventOp("runtime-event-domain", "authority-domain.jsonl", "evt-domain")]
    });
    const authorityReceipt = await runEffect(authority.flush("explicit"));

    assert.equal(runtimeEventReceipt.flush.opCount, 1);
    assert.equal(authorityReceipt.opCount, 1);
    assert.match(readFileSync(path.join(rootDir, ".harness/generated/runtime-events/authority-domain.jsonl"), "utf8"), /evt-domain/u);
    assert.equal(git(rootDir, "show", "sessions/authority-domain:tasks/task-authority-domain/note.md"), "authority");
    await runtime.stop();
  });
});

test("daemon interactive queue keeps matching attribution in separate integrity domains", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initAuthoredGit(rootDir);
    const runtime = createDaemonRuntime({ rootDir, materializerPollMs: false, interactiveMicroBatchMs: 20 });
    await runtime.start();
    const authorityOp = {
      ...docWrite("op-domain-authority", "task-domain-authority", "note.md", "authority domain\n"),
      authorityIntegrity: authorityIntegrity("44", "55", "66", "task-domain-authority")
    };
    const [authority, legacy] = await Promise.all([
      runtime.enqueueInteractiveWrite({ commandId: "authority-domain", attribution: testAttribution, ops: [authorityOp] }),
      runtime.enqueueInteractiveWrite({
        commandId: "legacy-domain",
        attribution: testAttribution,
        ops: [runtimeEventOp("runtime-event-matching-attribution", "matching-attribution.jsonl", "evt-matching-attribution")]
      })
    ]);

    assert.equal(authority.flush.opCount, 1);
    assert.equal(legacy.flush.opCount, 1);
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-domain-authority/note.md"), "utf8"), "authority domain\n");
    assert.match(readFileSync(path.join(rootDir, ".harness/generated/runtime-events/matching-attribution.jsonl"), "utf8"), /evt-matching-attribution/u);
    await runtime.stop();
  });
});

test("daemon upgrade attach replays a pre-domain journal in separate integrity batches", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initAuthoredGit(rootDir);
    const legacy = makeOperationalJournaledWriteCoordinator({
      rootDir,
      operationalActor: { scope: "operational", kind: "system", id: "legacy-runtime" },
      autoMaterialize: false
    });
    const authority = makeJournaledWriteCoordinator({
      rootDir,
      attribution: testAttribution,
      sessionId: "upgrade-authority",
      autoMaterialize: false
    });
    Effect.runSync(legacy.enqueue(runtimeEventOp(
      "runtime-event-pre-domain",
      "pre-domain.jsonl",
      "evt-pre-domain"
    )));
    Effect.runSync(authority.enqueue({
      ...docWrite("op-authority-pre-domain", "task-authority-pre-domain", "note.md", "authority upgrade\n"),
      authorityIntegrity: authorityIntegrity("77", "88", "99", "task-authority-pre-domain")
    }));

    const runtime = createDaemonRuntime({ rootDir, materializerPollMs: false });
    const status = await runtime.start();

    assert.equal(status.started, true);
    assert.equal(status.lastRecovery?.replayedOps, 2);
    assert.match(readFileSync(path.join(rootDir, ".harness/generated/runtime-events/pre-domain.jsonl"), "utf8"), /evt-pre-domain/u);
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-authority-pre-domain/note.md"), "utf8"), "authority upgrade\n");
    assert.match(git(rootDir, "log", "-2", "--format=%B"), /Harness-Authority-Batch:/u);
    await runtime.stop();
  });
});

test("daemon upgrade attach defers an unsafe domain without discarding a recoverable legacy domain", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initAuthoredGit(rootDir);
    const legacy = makeOperationalJournaledWriteCoordinator({
      rootDir,
      operationalActor: { scope: "operational", kind: "system", id: "legacy-runtime" },
      autoMaterialize: false
    });
    const authority = makeJournaledWriteCoordinator({ rootDir, attribution: testAttribution, autoMaterialize: false });
    Effect.runSync(legacy.enqueue(runtimeEventOp("runtime-event-safe-domain", "safe-domain.jsonl", "evt-safe-domain")));
    Effect.runSync(authority.enqueue({
      ...docWrite("op-unsafe-authority-domain", "task-unsafe-authority", "note.md", "must remain deferred\n"),
      authorityIntegrity: authorityIntegrity("aa", "bb", "cc", "task-unsafe-authority")
    }));
    const journalPath = path.join(rootDir, ".harness/write-journal/writes.jsonl");
    const oldLines = readFileSync(journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const unsafe = oldLines.find((record) => record.opId === "op-unsafe-authority-domain");
    unsafe.payload.payloadHash = "sha256:unsafe-upgrade-record";
    writeFileSync(journalPath, `${oldLines.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

    const runtime = createDaemonRuntime({ rootDir, materializerPollMs: false });
    const status = await runtime.start();

    assert.equal(status.started, true);
    assert.equal(status.lastRecovery?.replayedOps, 1);
    assert.equal(status.lastRecovery?.deferredOps, 1);
    assert.match(readFileSync(path.join(rootDir, ".harness/generated/runtime-events/safe-domain.jsonl"), "utf8"), /evt-safe-domain/u);
    const retained = readFileSync(journalPath, "utf8");
    assert.doesNotMatch(retained, /runtime-event-safe-domain/u);
    assert.match(retained, /op-unsafe-authority-domain/u);
    const liveLegacy = await runtime.enqueueInteractiveWrite({
      commandId: "legacy-after-deferred-authority",
      operationalActor: { scope: "operational", kind: "system", id: "daemon-runtime" },
      ops: [runtimeEventOp("runtime-event-after-deferred", "after-deferred.jsonl", "evt-after-deferred")]
    });
    assert.equal(liveLegacy.flush.opCount, 1);
    assert.match(readFileSync(path.join(rootDir, ".harness/generated/runtime-events/after-deferred.jsonl"), "utf8"), /evt-after-deferred/u);
    assert.match(readFileSync(journalPath, "utf8"), /op-unsafe-authority-domain/u);
    await runtime.stop();
  });
});

function authorityIntegrity(requestByte: string, mutationByte: string, actorByte: string, taskId: string) {
  return {
    schema: "authority-operation-integrity/v2" as const,
    semanticRequestDigest: requestByte.repeat(32),
    semanticMutationSetDigest: mutationByte.repeat(32),
    mutationRegistryVersion: 1,
    actorAxesBindingDigest: actorByte.repeat(32),
    canonicalMutationSet: {
      registryVersion: 1,
      mutations: [{
        entity: { registryVersion: 1, entityKind: "task", canonicalRef: `task/${taskId}` },
        action: { registryVersion: 1, action: "append" }
      }]
    }
  } as const;
}

function runtimeEventOp(opId: string, fileName: string, eventId: string) {
  return {
    opId,
    entityId: moduleEntityId("runtime-event-ledger"),
    kind: "machine_artifact_append_jsonl" as const,
    payload: {
      boundary: "runtime-event-ledger",
      path: `.harness/generated/runtime-events/${fileName}`,
      value: { schema: "runtime-event/v1", eventId }
    }
  };
}
