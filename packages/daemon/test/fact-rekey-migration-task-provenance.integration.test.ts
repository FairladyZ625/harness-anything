// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  REPLAY_TASK_GRAPH,
  eventObjectRelativePath,
  makeTaskEventStore,
  migrationImportWritePlan,
  serializeEventHead,
  serializePersistedCanonicalEvent,
  sha256Text,
  stableStringify,
  type MigrationImportEventV1,
} from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell, type RepoCell } from "../src/repo-cell.ts";
import { actor, initRepo } from "./migration-import.fixtures.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";

test("fact rekey restates legacy migration task provenance and is idempotent", async () => {
  const fixture = await legacyMigrationTaskFixture("missing-provenance");
  let cell: RepoCell | undefined;
  try {
    const unreadable = makeTaskEventStore({ repoId: fixture.repoId, rootDir: fixture.rootDir });
    assert.throws(() => unreadable.read(), /migration task entity is invalid/u);

    cell = await openRepoCell({
      repoId: workspaceId(fixture.repoId),
      rootDir: canonicalRoot(fixture.rootDir),
      ownerId: "migration-task-provenance-recovery",
      now: () => "2026-09-01T02:00:00.000Z",
    });
    const preview = await cell.run({ kind: "fact-rekey", dryRun: true }, fixture.binding),
      previewEvidence = JSON.parse(String(preview.evidence)) as {
        readonly counts: { readonly rewrittenMigrationTaskEvents: number };
        readonly migrationTaskProvenanceRestatements: readonly {
          readonly opId: string;
          readonly sourcePath: string;
        }[];
      };
    assert.equal(preview.outcome, "pending", JSON.stringify(preview));
    assert.equal(previewEvidence.counts.rewrittenMigrationTaskEvents, 1);
    assert.deepEqual(previewEvidence.migrationTaskProvenanceRestatements, [
      { opId: fixture.event.opId, sourcePath: fixture.sourcePath },
    ]);

    const applied = await cell.run({ kind: "fact-rekey" }, fixture.binding);
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    assert.equal(cell.status().state, "attached");
    assert.equal((await cell.run({ kind: "task-list" }, fixture.binding)).outcome, "applied");

    const repairedStore = makeTaskEventStore({ repoId: fixture.repoId, rootDir: fixture.rootDir }),
      repaired = repairedStore.readEvent(fixture.event.opId);
    assert.equal(repaired?.schema, "migration-import-event/v1");
    if (repaired?.schema === "migration-import-event/v1" && repaired.payload.entity.kind === "task") {
      assert.equal(repaired.eventId, fixture.event.eventId);
      assert.equal(repaired.opId, fixture.event.opId);
      assert.equal(repaired.workspaceRevision, fixture.event.workspaceRevision);
      assert.equal(repaired.payload.entity.provenance, "imported_snapshot");
      assert.equal(repaired.payload.entity.task.schema, "task/v2");
      assert.equal(repaired.payload.entity.task.pinned, false);
      assert.equal(repaired.payload.entity.task.packageDisposition, "active");
    }

    const repeated = await cell.run({ kind: "fact-rekey" }, fixture.binding),
      repeatedEvidence = JSON.parse(String(repeated.evidence)) as {
        readonly counts: { readonly rewrittenMigrationTaskEvents: number };
      };
    assert.equal(repeated.outcome, "no_changes", JSON.stringify(repeated));
    assert.equal(repeatedEvidence.counts.rewrittenMigrationTaskEvents, 0);

    await cell.close();
    cell = undefined;
    cell = await openRepoCell({
      repoId: workspaceId(fixture.repoId),
      rootDir: canonicalRoot(fixture.rootDir),
      ownerId: "migration-task-provenance-reattach",
    });
    assert.equal(cell.status().state, "attached");
    assert.equal((await cell.run({ kind: "task-list" }, fixture.binding)).outcome, "applied");
  } finally {
    await cell?.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test("fact rekey preserves the typed rejection for a non-target invalid migration task", async () => {
  const fixture = await legacyMigrationTaskFixture("missing-original-status");
  let cell: RepoCell | undefined;
  try {
    cell = await openRepoCell({
      repoId: workspaceId(fixture.repoId),
      rootDir: canonicalRoot(fixture.rootDir),
      ownerId: "migration-task-non-target-recovery",
    });
    const rejected = await cell.run({ kind: "fact-rekey", dryRun: true }, fixture.binding);
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "service_rejected");
    assert.match(String(rejected.nextAction), /migration task entity is invalid/u);
  } finally {
    await cell?.close();
    rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

async function legacyMigrationTaskFixture(defect: "missing-provenance" | "missing-original-status") {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-rekey-migration-task-")),
    repoId = `rekey-migration-task-${defect}`,
    taskId = `task_rekey_${defect.replaceAll("-", "_")}`,
    packagePath = `tasks/${taskId}-legacy`,
    documentBody = `# Legacy migration task\n`,
    documentSha = sha256Text(documentBody),
    binding = { actor, source: "local" as const };
  initRepo(rootDir);
  const bootstrap = await openBootstrappedRepoCell({
    repoId: workspaceId(repoId),
    rootDir: canonicalRoot(rootDir),
    ownerId: `bootstrap-${defect}`,
  });
  await bootstrap.close();

  const store = makeTaskEventStore({ repoId, rootDir }),
    event: MigrationImportEventV1 = {
      schema: "migration-import-event/v1",
      eventId: `event-${defect}`,
      workspaceRevision: (store.readHead()?.revision ?? 0) + 1,
      opId: `op-${defect}`,
      type: "entity_migrated",
      actor,
      source: "migration-import/v1",
      occurredAt: "2026-08-15T00:00:00.000Z",
      payload: {
        migratedFrom: taskId,
        generation: "v0",
        entity: {
          kind: "task",
          provenance: "imported_snapshot",
          task: {
            schema: "task/v2",
            taskId,
            title: "Legacy migration task",
            taskClass: "standard",
            status: "planned",
            graph: REPLAY_TASK_GRAPH,
            currentNode: "implementation",
            iteration: 0,
            pinned: false,
            packageDisposition: "active",
            createdBy: actor,
            completionGateIds: [],
            presetSnapshotDigest: null,
          },
          originalStatus: "planned",
          packagePath,
          documentClaim: {
            path: `${packagePath}/INDEX.md`,
            sha256: documentSha,
            size: Buffer.byteLength(documentBody),
            mediaType: "text/markdown",
            policyId: "typed-migration-import/v1",
          },
        },
      },
    };
  store.append({
    event,
    plan: migrationImportWritePlan(event),
    blobs: [
      {
        body: documentBody,
        sha256: documentSha,
        size: Buffer.byteLength(documentBody),
        mediaType: "text/markdown",
      },
    ],
  });
  await store.drain();

  const legacy = JSON.parse(serializePersistedCanonicalEvent(event)) as Record<string, unknown>,
    payload = legacy.payload as { entity: Record<string, unknown> },
    entity = payload.entity;
  if (defect === "missing-provenance") {
    delete entity.provenance;
    const task = entity.task as Record<string, unknown>;
    task.schema = "task/v1";
    delete task.pinned;
    delete task.packageDisposition;
  } else delete entity.originalStatus;
  const body = `${stableStringify(legacy)}\n`,
    relativeEventPath = eventObjectRelativePath(event.opId, store.layout()),
    sourcePath = `harness/${relativeEventPath}`;
  writeFileSync(path.join(rootDir, sourcePath), body);
  writeFileSync(
    path.join(rootDir, "harness/events/head.json"),
    serializeEventHead({
      revision: event.workspaceRevision,
      opId: event.opId,
      eventDigest: `sha256:${sha256Text(body)}`,
    }),
  );
  git(rootDir, "add", "harness/events");
  git(rootDir, "commit", "-qm", `seed ${defect} migration event`);
  git(rootDir, "update-ref", "refs/ha/canonical", "HEAD");
  for (const suffix of ["", "-shm", "-wal"])
    rmSync(path.join(rootDir, `.harness/cache/task.sqlite${suffix}`), { force: true });
  assert.equal(readFileSync(path.join(rootDir, sourcePath), "utf8"), body);
  return { binding, event, repoId, rootDir, sourcePath };
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
