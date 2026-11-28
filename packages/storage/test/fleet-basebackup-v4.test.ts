// harness-test-tier: contract
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { createZstdDecompress } from "node:zlib";
import * as tar from "tar";
import { serializePersistedCanonicalEvent, type PersistedCanonicalEventV1 } from "@harness-anything/kernel";
import { DOC_CODEC_ID, DOC_POLICY_ID } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import {
  RAW_ARTIFACT_MEDIA_TYPE,
  RAW_ARTIFACT_POLICY_ID,
} from "@harness-anything/kernel/internal/domain/artifact-text-classification.ts";
import { REPLAY_TASK_GRAPH } from "@harness-anything/kernel/internal/domain/task-graph.ts";
import {
  BASE_BACKUP_ARCHIVE_ROOT,
  COLD_BLOB_SIZE_THRESHOLD_BYTES,
  createHotSetTracker,
  hydrateReplicaSeed,
  openSqliteEventStore,
  startBaseBackup,
} from "../src/index.ts";
import { prepareSqlBaseBackup } from "../src/postgres/pg-basebackup.ts";
import { openReplicaProjection } from "../src/replica-projection.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const actor = {
  principal: { personId: "owner" },
  executor: { kind: "agent" as const, id: "codex" },
};

function makeTaskRecord(taskId: string, status: "planned" | "active" | "done" | "cancelled") {
  return {
    schema: "task/v2" as const,
    taskId,
    title: `Task ${taskId}`,
    taskClass: "standard" as const,
    status,
    graph: REPLAY_TASK_GRAPH,
    currentNode: "implementation",
    iteration: 0,
    createdBy: actor,
    completionGateIds: [],
    presetSnapshotDigest: null,
    pinned: false,
  };
}

function makeTaskCreatedEvent(
  revision: number,
  taskId: string,
  opId = `op_create_${revision}`,
): PersistedCanonicalEventV1 {
  return {
    schema: "task-event/v1",
    eventId: `ev_${opId}`,
    workspaceRevision: revision,
    opId,
    taskId,
    type: "task_created",
    actor,
    source: "local",
    occurredAt: "2026-11-28T00:00:00.000Z",
    payload: {
      task: makeTaskRecord(taskId, "planned"),
    },
  } as unknown as PersistedCanonicalEventV1;
}

function makeTaskCompletedEvent(
  revision: number,
  taskId: string,
  opId = `op_done_${revision}`,
): PersistedCanonicalEventV1 {
  return {
    schema: "task-event/v1",
    eventId: `ev_${opId}`,
    workspaceRevision: revision,
    opId,
    taskId,
    type: "task_archived",
    actor,
    source: "local",
    occurredAt: "2026-11-28T00:00:02.000Z",
    payload: {
      task: makeTaskRecord(taskId, "done"),
      mutation: { command: "archive", reason: "historical archive", fields: ["status"] },
      documentClaims: [],
    },
  } as unknown as PersistedCanonicalEventV1;
}

function makeDocEvent(input: {
  readonly repoId: string;
  readonly revision: number;
  readonly opId?: string;
  readonly changes: readonly {
    readonly path: string;
    readonly sha256: string;
    readonly size: number;
    readonly mediaType?: string;
    readonly policyId?: string;
  }[];
}): PersistedCanonicalEventV1 {
  const opId = input.opId ?? `op_doc_${input.revision}`;
  return {
    schema: "doc-event/v1",
    eventId: `ev_${opId}`,
    workspaceRevision: input.revision,
    opId,
    type: "documents_written",
    actor,
    source: "local",
    occurredAt: "2026-11-28T00:00:01.000Z",
    payload: {
      executionId: "exe_1",
      baseLedgerSha: {
        repoId: input.repoId,
        revision: Math.max(0, input.revision - 1),
        headDigest: `sha256:${"0".repeat(64)}`,
      },
      changes: input.changes.map((c) => {
        const policyId = c.policyId ?? DOC_POLICY_ID;
        return {
          path: c.path,
          baseBlobSha256: null,
          policyId,
          candidate: {
            sha256: c.sha256,
            size: c.size,
            mediaType: c.mediaType ?? (policyId === RAW_ARTIFACT_POLICY_ID ? RAW_ARTIFACT_MEDIA_TYPE : "text/markdown"),
          },
          regionProofs:
            policyId === DOC_POLICY_ID
              ? [
                  {
                    regionId: "heading/shared",
                    policyId: DOC_POLICY_ID,
                    codecId: DOC_CODEC_ID,
                    baseSha256: sha256(""),
                    candidateSha256: c.sha256,
                    insertBytes: c.size,
                  },
                ]
              : [],
        };
      }),
    },
  } as unknown as PersistedCanonicalEventV1;
}

test("createHotSetTracker deterministically separates hot set from >=64 KiB terminal-task cold artifacts", () => {
  const tracker = createHotSetTracker();
  const smallArchivedArtifact = sha256("small-archived-artifact");
  const largeArchivedArtifact = sha256("large-archived-artifact");
  const largeActiveArtifact = sha256("large-active-artifact");
  const largeCorePlan = sha256("large-core-plan");
  const largeDecision = sha256("large-decision");
  const sharedHotAndCold = sha256("shared-blob");

  tracker.observeEvent(makeTaskCreatedEvent(1, "task_done1"));
  tracker.observeEvent(makeTaskCreatedEvent(2, "task_live1"));
  tracker.observeEvent(
    makeDocEvent({
      repoId: "repo-hotset",
      revision: 3,
      changes: [
        {
          path: "tasks/task_done1-slug/artifacts/small.log",
          sha256: smallArchivedArtifact,
          size: COLD_BLOB_SIZE_THRESHOLD_BYTES - 1,
        },
        {
          path: "tasks/task_done1-slug/artifacts/big-trace.bin",
          sha256: largeArchivedArtifact,
          size: COLD_BLOB_SIZE_THRESHOLD_BYTES + 4096,
        },
        {
          path: "tasks/task_done1-slug/task_plan.md",
          sha256: largeCorePlan,
          size: COLD_BLOB_SIZE_THRESHOLD_BYTES + 2048,
        },
        {
          path: "tasks/task_live1-slug/artifacts/active.bin",
          sha256: largeActiveArtifact,
          size: COLD_BLOB_SIZE_THRESHOLD_BYTES + 8192,
        },
        {
          path: "decisions/dec_001.md",
          sha256: largeDecision,
          size: COLD_BLOB_SIZE_THRESHOLD_BYTES + 1024,
        },
        {
          path: "tasks/task_done1-slug/artifacts/shared.bin",
          sha256: sharedHotAndCold,
          size: COLD_BLOB_SIZE_THRESHOLD_BYTES + 128,
        },
        {
          path: "facts/fact_001.md",
          sha256: sharedHotAndCold,
          size: COLD_BLOB_SIZE_THRESHOLD_BYTES + 128,
        },
      ],
    }),
  );
  tracker.observeEvent(makeTaskCompletedEvent(4, "task_done1"));

  const result = tracker.finalize();
  assert.equal(result.coldCount, 1);
  assert.equal(result.hotCount, 5);
  const byHash = new Map(result.entries.map((entry) => [entry.sha256, entry.tier]));
  assert.equal(byHash.get(largeArchivedArtifact), "cold");
  assert.equal(byHash.get(smallArchivedArtifact), "hot");
  assert.equal(byHash.get(largeActiveArtifact), "hot");
  assert.equal(byHash.get(largeCorePlan), "hot");
  assert.equal(byHash.get(largeDecision), "hot");
  assert.equal(byHash.get(sharedHotAndCold), "hot");
  assert.equal(result.entries.at(-1)?.sha256, largeArchivedArtifact);
  assert.equal(result.entries.at(-1)?.tier, "cold");
});

test("startBaseBackup produces zstd fleet-basebackup/v4 archives with hot/cold split metadata and preserves v3", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-bb-v4-storage-"));
  t.after(() => removeTempRepository(root));

  const repoId = "repo-v4";
  const repoRoot = path.join(root, "repo");
  const ledgerPath = path.join(repoRoot, ".harness", "store", "generations", "3", "ledger.sqlite");
  const projectionPath = path.join(repoRoot, ".harness", "cache", "task.sqlite");
  const store = openSqliteEventStore({ repoId, databasePath: ledgerPath, generation: 3 });
  const hotBytes = Buffer.from("# Hot Plan\n", "utf8");
  const coldBytes = Buffer.from(
    `# Large Historical Artifact Report\n${"x".repeat(COLD_BLOB_SIZE_THRESHOLD_BYTES + 16_384)}\n`,
    "utf8",
  );
  const hotSha = sha256(hotBytes);
  const coldSha = sha256(coldBytes);
  const fence = { repoId, holder: "primary", epoch: 1 };
  try {
    store.appendCommand({
      fence,
      intent: { opId: "op_create_1", intentDigest: `sha256:${sha256("op_create_1")}`, summary: "create task" },
      events: [makeTaskCreatedEvent(1, "task_archived01", "op_create_1") as never],
    });
    store.appendCommand({
      fence,
      intent: { opId: "op_doc_2", intentDigest: `sha256:${sha256("op_doc_2")}`, summary: "write docs" },
      events: [
        makeDocEvent({
          repoId,
          revision: 2,
          opId: "op_doc_2",
          changes: [
            {
              path: "tasks/task_archived01-archived/task_plan.md",
              sha256: hotSha,
              size: hotBytes.length,
              mediaType: "text/markdown",
            },
            {
              path: "tasks/task_archived01-archived/artifacts/large-report.md",
              sha256: coldSha,
              size: coldBytes.length,
              mediaType: "text/markdown",
            },
          ],
        }) as never,
      ],
      blobs: [
        { sha256: hotSha, size: hotBytes.length, mediaType: "text/markdown", body: hotBytes },
        { sha256: coldSha, size: coldBytes.length, mediaType: "text/markdown", body: coldBytes },
      ],
    });
    store.appendCommand({
      fence,
      intent: { opId: "op_done_3", intentDigest: `sha256:${sha256("op_done_3")}`, summary: "complete task" },
      events: [makeTaskCompletedEvent(3, "task_archived01", "op_done_3") as never],
    });
  } finally {
    store.close();
  }

  const projection = openReplicaProjection({
    repoId,
    rootDir: repoRoot,
    ledgerPath,
    projectionPath,
    generation: 3,
  });
  try {
    await projection.projection.catchUpAsync!();
  } finally {
    projection.close();
  }

  // v4 zstd split backup
  const v4Dir = path.join(root, "backup-v4");
  mkdirSync(v4Dir, { recursive: true });
  const v4Started = await startBaseBackup({
    ledgerPath,
    projectionPath,
    directory: v4Dir,
    mode: "split",
    format: "v4",
  });
  assert.equal(v4Started.metadata.schema, "fleet-basebackup/v4");
  const v4Archive = await v4Started.complete;
  assert.equal(path.basename(v4Archive.file), "base.tar.zst");
  assert.equal(v4Archive.hotObjectCount, 1);
  assert.equal(v4Archive.coldObjectCount, 1);
  assert.deepEqual(
    v4Archive.objects?.map((o) => ({ sha256: o.sha256, tier: o.tier })),
    [
      { sha256: hotSha, tier: "hot" },
      { sha256: coldSha, tier: "cold" },
    ],
  );
  // Verify native zstd decompression unpacks backup.json cleanly.
  const unpackedDir = path.join(root, "unpacked-v4");
  mkdirSync(unpackedDir, { recursive: true });
  await pipeline(createReadStream(v4Archive.file), createZstdDecompress(), new tar.Unpack({ cwd: unpackedDir }));
  const parsedMeta = JSON.parse(readFileSync(path.join(unpackedDir, "backup.json"), "utf8"));
  assert.equal(parsedMeta.schema, "fleet-basebackup/v4");

  // v3 gzip split backup backward compatibility
  const v3Dir = path.join(root, "backup-v3");
  mkdirSync(v3Dir, { recursive: true });
  const v3Started = await startBaseBackup({
    ledgerPath,
    projectionPath,
    directory: v3Dir,
    mode: "split",
    format: "v3",
  });
  assert.equal(v3Started.metadata.schema, "fleet-basebackup/v3");
  const v3Archive = await v3Started.complete;
  assert.equal(path.basename(v3Archive.file), "base.tar.gz");
  assert.equal(
    v3Archive.objects?.every((o) => o.tier === undefined),
    true,
  );
});

test("PG streaming NDJSON basebackup exports chunked batches without whole-snapshot JSON.stringify and hydrates cleanly", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-pg-ndjson-"));
  t.after(() => removeTempRepository(root));

  const repoId = "repo-pg";
  const hotBody = Buffer.from("# Hot PG Doc\n", "utf8");
  const coldBody = Buffer.from(`# Cold PG Artifact\n${"y".repeat(COLD_BLOB_SIZE_THRESHOLD_BYTES + 4096)}\n`, "utf8");
  const hotSha = sha256(hotBody);
  const coldSha = sha256(coldBody);

  // Build 2,050 events so batch size 1000 executes 3 paginated SQL queries.
  const totalEvents = 2050;
  const eventRows: Array<{
    revision: string;
    op_id: string;
    event_json: string;
    occurred_at: string;
    recorded_at: string;
    event_digest: `sha256:${string}`;
  }> = [];
  const outcomeRows: Array<{
    op_id: string;
    status: "accepted_durable";
    first_revision: string;
    last_revision: string;
    intent_digest: `sha256:${string}`;
    intent_summary: string;
    rejection_code: null;
    recorded_at: string;
    member_op_ids: string[];
  }> = [];

  for (let rev = 1; rev <= totalEvents; rev += 1) {
    const opId = `op_pg_${rev}`;
    const event =
      rev === 1
        ? makeTaskCreatedEvent(rev, "task_pg_arch", opId)
        : rev === 2
          ? makeDocEvent({
              repoId,
              revision: rev,
              opId,
              changes: [
                {
                  path: "tasks/task_pg_arch-pg/task_plan.md",
                  sha256: hotSha,
                  size: hotBody.length,
                  mediaType: "text/markdown",
                },
                {
                  path: "tasks/task_pg_arch-pg/artifacts/cold-pg.bin",
                  sha256: coldSha,
                  size: coldBody.length,
                  policyId: RAW_ARTIFACT_POLICY_ID,
                  mediaType: RAW_ARTIFACT_MEDIA_TYPE,
                },
              ],
            })
          : rev === totalEvents
            ? makeTaskCompletedEvent(rev, "task_pg_arch", opId)
            : makeTaskCreatedEvent(rev, `task_extra_${rev}`, opId);
    const eventJson = serializePersistedCanonicalEvent(event);
    eventRows.push({
      revision: String(rev),
      op_id: opId,
      event_json: eventJson,
      occurred_at: "2026-11-28T00:00:00.000Z",
      recorded_at: "2026-11-28T00:00:00.000Z",
      event_digest: `sha256:${sha256(eventJson)}`,
    });
    outcomeRows.push({
      op_id: opId,
      status: "accepted_durable",
      first_revision: String(rev),
      last_revision: String(rev),
      intent_digest: `sha256:${sha256(opId)}`,
      intent_summary: `summary ${rev}`,
      rejection_code: null,
      recorded_at: "2026-11-28T00:00:00.000Z",
      member_op_ids: [opId],
    });
  }

  let eventQueryPages = 0;
  let outcomeQueryPages = 0;
  const mockClient = {
    on: () => undefined,
    off: () => undefined,
    removeListener: () => undefined,
    query: async (sql: string, params: unknown[] = []) => {
      if (
        sql.startsWith("BEGIN") ||
        sql.startsWith("COMMIT") ||
        sql.startsWith("ROLLBACK") ||
        sql.includes("set_config")
      ) {
        return { rows: [] };
      }
      if (sql.includes("FROM ha_repo_heads") && sql.includes("ha_repo_sync_watermarks")) {
        return {
          rows: [
            {
              revision: String(totalEvents),
              replication_history: "pg-hist-1",
              readers: [],
              policy_epoch: "0",
              max_seq: String(totalEvents),
              wm_history: "pg-hist-1",
              wm_rev: String(totalEvents),
              wm_seq: String(totalEvents),
              can_write: false,
            },
          ],
        };
      }
      if (sql.includes("SELECT writer_holder_id,writer_epoch FROM ha_repo_heads")) {
        return { rows: [{ writer_holder_id: "pg-primary", writer_epoch: "7" }] };
      }
      if (sql.includes("FROM ha_events")) {
        eventQueryPages += 1;
        const after = Number(params[3]);
        const through = Number(params[4]);
        const limit = Number(params[5]);
        return {
          rows: eventRows.filter((r) => Number(r.revision) > after && Number(r.revision) <= through).slice(0, limit),
        };
      }
      if (sql.includes("FROM ha_command_outcomes")) {
        outcomeQueryPages += 1;
        const limit = Number(params[4]);
        const offset = Number(params[5]);
        return { rows: outcomeRows.slice(offset, offset + limit) };
      }
      if (sql.includes("FROM ha_content_blobs")) {
        const wanted = new Set(params[2] as string[]);
        const all = [
          { sha256: hotSha, size: hotBody.length, body: hotBody },
          { sha256: coldSha, size: coldBody.length, body: coldBody },
        ];
        return { rows: all.filter((row) => wanted.has(row.sha256)) };
      }
      return { rows: [] };
    },
    release: () => undefined,
  };
  const mockPool = { connect: async () => mockClient } as unknown as import("pg").Pool;

  const outDir = path.join(root, "pg-out");
  let pinnedMeta: unknown = null;
  const metadata = await prepareSqlBaseBackup(
    {
      repoId,
      directory: outDir,
      mode: "split",
      format: "v4",
      storage: {
        backend: "postgres",
        connectionString: "postgres://unused",
        authorityConnectionString: "postgres://unused",
        scope: { tenantId: "tenant-test", projectId: "project-test", policyEpoch: 0 },
      },
    },
    (m) => {
      pinnedMeta = m;
    },
    mockPool,
  );
  assert.ok(pinnedMeta);
  assert.equal(metadata.schema, "fleet-basebackup/v4");
  assert.equal(eventQueryPages, 3, "PG export must stream events in bounded SQL batches");
  assert.equal(outcomeQueryPages, 3, "PG export must stream outcomes in bounded SQL batches");

  const payloadDir = path.join(outDir, "payload");
  const ndjsonPath = path.join(
    payloadDir,
    BASE_BACKUP_ARCHIVE_ROOT,
    "store",
    "generations",
    "3",
    "canonical-seed.ndjson",
  );
  assert.equal(existsSync(ndjsonPath), true, "v4 PG export writes streaming canonical-seed.ndjson");
  const lines = readFileSync(ndjsonPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1 + totalEvents + totalEvents);
  const objects = JSON.parse(readFileSync(path.join(payloadDir, "objects.json"), "utf8")) as Array<{
    sha256: string;
    tier: string;
  }>;
  assert.deepEqual(
    objects.map((o) => ({ sha256: o.sha256, tier: o.tier })),
    [
      { sha256: hotSha, tier: "hot" },
      { sha256: coldSha, tier: "cold" },
    ],
  );

  // Hydrate 3-event NDJSON seed with ONLY hot blob on disk (cold blob deferred) to verify streaming hydration!
  const hydrateDir = path.join(root, "hydrate-v4");
  const hydrateStoreDir = path.join(hydrateDir, BASE_BACKUP_ARCHIVE_ROOT, "store", "generations", "3");
  mkdirSync(path.join(hydrateStoreDir, "objects", "sha256", hotSha.slice(0, 2)), { recursive: true });
  writeFileSync(path.join(hydrateStoreDir, "objects", "sha256", hotSha.slice(0, 2), hotSha.slice(2)), hotBody);
  const completedAt3 = makeTaskCompletedEvent(3, "task_pg_arch", "op_pg_done3");
  const completedAt3Json = serializePersistedCanonicalEvent(completedAt3);
  const smallSeedLines = [
    lines[0]!,
    lines[1]!,
    lines[2]!,
    JSON.stringify({
      kind: "event",
      row: {
        revision: 3,
        opId: "op_pg_done3",
        eventJson: completedAt3Json,
        occurredAt: "2026-11-28T00:00:02.000Z",
        recordedAt: "2026-11-28T00:00:02.000Z",
        digest: `sha256:${sha256(completedAt3Json)}`,
      },
    }),
    lines[1 + totalEvents]!,
    lines[1 + totalEvents + 1]!,
    JSON.stringify({
      kind: "outcome",
      row: {
        opId: "op_pg_done3",
        status: "accepted_durable",
        firstRevision: 3,
        lastRevision: 3,
        intentDigest: `sha256:${sha256("op_pg_done3")}`,
        summary: "done",
        rejectionCode: null,
        recordedAt: "2026-11-28T00:00:02.000Z",
        memberOpIds: ["op_pg_done3"],
      },
    }),
  ];
  writeFileSync(path.join(hydrateStoreDir, "canonical-seed.ndjson"), `${smallSeedLines.join("\n")}\n`);
  await hydrateReplicaSeed(hydrateDir, {
    ...metadata,
    position: { history: "pg-hist-1", sequence: 3, revision: 3 },
  });
  assert.equal(existsSync(path.join(hydrateStoreDir, "ledger.sqlite")), true);
  assert.equal(existsSync(path.join(hydrateStoreDir, "canonical-seed.ndjson")), false);
});
