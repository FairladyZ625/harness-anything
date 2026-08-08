// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  actorAxesBindingCoreDigestV2,
  type ActorAxesBindingCoreV2
} from "../../src/integrity/actor-axes-binding-integrity-v2.ts";
import { encodeCanonicalCbor } from "../../src/integrity/canonical-cbor.ts";
import {
  semanticMutationSetDigestV2,
  semanticMutationWireV2,
  type SemanticMutationSetV2,
  type SemanticMutationV2
} from "../../src/integrity/semantic-mutation-integrity-v2.ts";
import { readProjectionSourceCacheSnapshot } from "../../src/projection/sqlite-projection-source-cache.ts";
import { rebuildTaskProjection } from "../../src/projection/sqlite-task-projection.ts";
import {
  canonicalAttributionEventDigestV2,
  physicalChangeSetDigestV2,
  type AttributionEventV2,
  type PhysicalChangeV2
} from "../../src/schemas/attribution-event-union.ts";
import { makeLocalAuthorityAttributionEventV2Log } from "../../src/write-coordination/attribution/authority-attribution-event-v2-log.ts";

const digestA = "11".repeat(32);
const digestB = "22".repeat(32);

test("a cold process warm-started from the persisted cache captures the authored fingerprint", () => {
  withTempProjection((rootDir) => {
    seedHarness(rootDir);
    rebuildTaskProjection({ rootDir });
    const storedSourceHash = readStoredSourceHash(rootDir);

    const warmed = runFreshCapture(rootDir, "warm");
    const cold = runFreshCapture(rootDir, "cold");

    assert.equal(warmed.warmStart, "warmed");
    // The load-bearing assertion: a warm-started capture must name the same
    // generation an authored read names, or the fingerprint it persists can never
    // be reproduced and every later cold process is forced into a full rebuild.
    assert.equal(warmed.fingerprint, cold.fingerprint);
    assert.equal(warmed.fingerprint, storedSourceHash);
    assert.equal(warmed.attributionSourceHash, cold.attributionSourceHash);
    // The warm start exists to stop re-reading authored bodies a cold process
    // already has in the projection.
    assert.equal(warmed.authoredBodiesRead, 0);
    assert.ok(cold.authoredBodiesRead > 0, `expected the cold capture to read authored bodies, read ${cold.authoredBodiesRead}`);
  });
});

test("an out-of-band authored change is never masked by the warm start", () => {
  withTempProjection((rootDir) => {
    seedHarness(rootDir);
    rebuildTaskProjection({ rootDir });
    const storedSourceHash = readStoredSourceHash(rootDir);
    // Edited while no writer is running, exactly the window a restart opens.
    writeIndex(rootDir, "task-b", "Task task-b edited out of band", "done");

    const warmed = runFreshCapture(rootDir, "warm");
    const cold = runFreshCapture(rootDir, "cold");

    assert.equal(warmed.warmStart, "stale");
    assert.equal(warmed.fingerprint, cold.fingerprint);
    assert.notEqual(warmed.fingerprint, storedSourceHash);
  });
});

test("a removed authored source invalidates the warm start instead of being reused", () => {
  withTempProjection((rootDir) => {
    seedHarness(rootDir);
    rebuildTaskProjection({ rootDir });
    rmSync(path.join(rootDir, "harness/tasks/task-c"), { recursive: true, force: true });

    const warmed = runFreshCapture(rootDir, "warm");
    const cold = runFreshCapture(rootDir, "cold");

    assert.equal(warmed.warmStart, "stale");
    assert.equal(warmed.fingerprint, cold.fingerprint);
    assert.equal(warmed.taskInputCount, cold.taskInputCount);
  });
});

test("the persisted source cache read is memoized per projection database generation", () => {
  withTempProjection((rootDir) => {
    seedHarness(rootDir);
    rebuildTaskProjection({ rootDir });
    const projectionPath = path.join(rootDir, ".harness/cache/projections.sqlite");

    const first = readProjectionSourceCacheSnapshot(projectionPath);
    const second = readProjectionSourceCacheSnapshot(projectionPath);
    assert.equal(first, second);

    writeIndex(rootDir, "task-a", "Task task-a rebuilt", "done");
    rebuildTaskProjection({ rootDir });
    const afterWrite = readProjectionSourceCacheSnapshot(projectionPath);
    assert.notEqual(afterWrite, first);
    assert.notEqual(afterWrite.hash, first.hash);
  });
});

interface FreshCaptureResult {
  readonly warmStart: string;
  readonly fingerprint: string;
  readonly attributionSourceHash: string;
  readonly taskInputCount: number;
  readonly authoredBodiesRead: number;
}

function runFreshCapture(rootDir: string, mode: "warm" | "cold"): FreshCaptureResult {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", freshCaptureScript], {
    cwd: process.cwd(),
    env: { ...process.env, HARNESS_ROOT: rootDir, HARNESS_WARM_START: mode },
    encoding: "utf8"
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim()) as FreshCaptureResult;
}

function readStoredSourceHash(rootDir: string): string {
  const db = new DatabaseSync(path.join(rootDir, ".harness/cache/projections.sqlite"), { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM projection_meta WHERE key = 'sourceHash'").get() as { value: string };
    return row.value;
  } finally {
    db.close();
  }
}

function withTempProjection(run: (rootDir: string) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-projection-warm-start-"));
  try {
    run(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function seedHarness(rootDir: string): void {
  for (const taskId of ["task-a", "task-b", "task-c"]) {
    writeIndex(rootDir, taskId, `Task ${taskId}`, "active");
  }
  // A v1 event id that sorts after the `authority-v2/` prefix: the persisted rows
  // are ordered by root-relative source path, which puts every v1 shard before
  // every v2 shard, while the authored reader orders by event relative path. Only
  // an interleaving fixture can catch a reconstruction that hashes in cache order.
  writeAttributionEvent(rootDir, "zz-event-after-authority", "task/task-a");
  writeAttributionEvent(rootDir, "00-event-before-authority", "task/task-b");
  makeLocalAuthorityAttributionEventV2Log(rootDir).ensure(v2Event([
    mutation("fact", "fact/task_T/F-1", "create")
  ]));
}

function writeIndex(rootDir: string, taskId: string, title: string, status: string): string {
  const indexPath = path.join(rootDir, "harness", "tasks", taskId, "INDEX.md");
  mkdirSync(path.dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    `title: ${title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    `  status: ${status}`,
    "  ref: ",
    `  titleSnapshot: ${title}`,
    "  url: ",
    "  bindingCreatedAt: 2026-07-07T00:00:00.000Z",
    "  bindingFingerprint: sha256:fixture",
    "packageDisposition: active",
    "---",
    ""
  ].join("\n"));
  stamp(indexPath);
  return indexPath;
}

function writeAttributionEvent(rootDir: string, eventId: string, entityId: string): string {
  const eventPath = path.join(rootDir, "harness/attribution-events", `${eventId}.jsonl`);
  mkdirSync(path.dirname(eventPath), { recursive: true });
  writeFileSync(eventPath, `${JSON.stringify({
    schema: "attribution-event/v1",
    eventId,
    opId: `op-${eventId}`,
    journalRecordSchema: "write-journal/v2",
    entityId,
    kind: "progress_append",
    actor: {
      principal: { kind: "person", personId: "person_test" },
      executor: { kind: "agent", id: "agent_test" }
    },
    principalSource: {
      kind: "local-configured",
      authority: "harness.yaml",
      authoritySha256: `sha256:${"0".repeat(64)}`
    },
    executorSource: "client-asserted",
    at: "2026-07-07T00:00:00.000Z",
    recordedAt: "2026-07-07T00:00:01.000Z",
    payloadHash: `sha256:${"1".repeat(64)}`,
    payloadRef: {
      path: `.harness/payloads/${eventId}.json`,
      sha256: `sha256:${"1".repeat(64)}`
    }
  })}\n`);
  stamp(eventPath);
  return eventPath;
}

function v2Event(mutations: ReadonlyArray<SemanticMutationV2>): AttributionEventV2 {
  const mutationSet: SemanticMutationSetV2 = {
    registryVersion: 1,
    mutations: [...mutations].sort((left, right) => Buffer.compare(
      Buffer.from(encodeCanonicalCbor(semanticMutationWireV2(left))),
      Buffer.from(encodeCanonicalCbor(semanticMutationWireV2(right)))
    ))
  };
  const actorAxesBinding: ActorAxesBindingCoreV2 = {
    bindingId: "binding-1",
    principalPersonId: "person_test",
    executorAgentId: "agent-test",
    workspaceId: "workspace-1",
    deviceId: "device-1",
    viewId: "view-1",
    sessionId: "session-1",
    schemaTuple: {
      wire: 2,
      event: 2,
      receipt: 2,
      digest: 2,
      policy: 1,
      commandRegistry: 1,
      entityRegistry: 1,
      mutationRegistry: 1,
      localState: 1,
      applyJournal: 1
    }
  };
  const physicalChanges: ReadonlyArray<PhysicalChangeV2> = [{
    path: "tasks/task_T/facts.md",
    beforeDigest: digestA,
    afterDigest: digestB
  }];
  const withoutEventDigest: Omit<AttributionEventV2, "canonicalEventDigest"> = {
    schema: "attribution-event/v2",
    eventId: "attribution:v2-op",
    workspaceId: "workspace-1",
    opId: "v2-op",
    revision: 1,
    commitSha: "commit-v2",
    previousCommit: "commit-v1",
    outcome: "COMMITTED",
    occurredAt: "2026-07-13T00:00:01.000Z",
    recordedAt: "2026-07-13T00:00:01.100Z",
    actorAxesBinding,
    semanticRequestDigest: "33".repeat(32),
    mutationSet,
    semanticMutationSetDigest: hex(semanticMutationSetDigestV2(mutationSet)),
    actorAxesBindingDigest: hex(actorAxesBindingCoreDigestV2(actorAxesBinding)),
    physicalChanges,
    changeSetDigest: hex(physicalChangeSetDigestV2(physicalChanges))
  };
  return {
    ...withoutEventDigest,
    canonicalEventDigest: hex(canonicalAttributionEventDigestV2(withoutEventDigest))
  };
}

function mutation(entityKind: string, canonicalRef: string, action: string): SemanticMutationV2 {
  return {
    entity: { registryVersion: 1, entityKind, canonicalRef },
    action: { registryVersion: 1, action }
  };
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function stamp(filePath: string): void {
  const fixed = new Date("2026-07-07T00:00:00.000Z");
  utimesSync(filePath, fixed, fixed);
}

const freshCaptureScript = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const originalReadFileSync = fs.readFileSync;
let authoredBodiesRead = 0;
fs.readFileSync = function(input, ...args) {
  const inputPath = typeof input === "string" ? input : "";
  if (/\\/harness\\/(?:tasks|decisions|attribution-events|authority-attribution-events)\\//u.test(inputPath)) {
    authoredBodiesRead += 1;
  }
  return Reflect.apply(originalReadFileSync, this, [input, ...args]);
};
syncBuiltinESMExports();
const rootDir = process.env.HARNESS_ROOT;
const { resolveHarnessLayout } = await import("./packages/kernel/src/layout/index.ts");
const { captureProjectionSourceFingerprint } = await import("./packages/kernel/src/projection/projection-source-snapshot.ts");
const { readDeclaredSourceManifestRows } = await import("./packages/kernel/src/projection/sqlite-declared-source-manifest.ts");
const { warmStartProjectionSourceCaches } = await import("./packages/kernel/src/projection/projection-source-cache-warm-start.ts");
const projectionPath = resolveHarnessLayout(rootDir).projectionPath;
const hints = readDeclaredSourceManifestRows(projectionPath);
const warmStart = process.env.HARNESS_WARM_START === "warm"
  ? warmStartProjectionSourceCaches(rootDir, projectionPath)
  : "skipped";
authoredBodiesRead = 0;
const source = captureProjectionSourceFingerprint(rootDir, hints);
process.stdout.write(JSON.stringify({
  warmStart,
  fingerprint: source.fingerprint,
  attributionSourceHash: source.attributionSource.hash,
  taskInputCount: source.taskSource.sourceInputs.length,
  authoredBodiesRead
}));
`;
