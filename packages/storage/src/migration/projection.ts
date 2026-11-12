import { decideReadableTaskLease } from "@harness-anything/kernel/internal/domain/task-lease-policy.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { canonicalJson } from "../projection/rebuildable-task-projection-sql.ts";
import { canonicalEventEntityRefs } from "@harness-anything/kernel";
import {
  DISPATCH_LIFECYCLE_PAGE_LIMIT,
  type CanonicalEventStore,
  type CanonicalEventV1,
  type TaskProjection,
} from "@harness-anything/kernel";
import { canonicalEventContentClaims } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import { entityKindContracts } from "@harness-anything/kernel/internal/domain/entity-kind-registry.ts";
import { makeTaskProjection } from "../projection/rebuildable-task-projection.ts";
import { StorageMigrationError, type MigrationTuple } from "./types.ts";
import { assertMigrationValue } from "./manifest.ts";

/** Snapshot stream implements the same bounded replay contract as the ledger, including content prefetch. */
export function migrationEventStream(
  repoId: string,
  tuple: Pick<MigrationTuple, "events" | "blobs">,
): CanonicalEventStore {
  const events = tuple.events.map((row) => JSON.parse(row.eventJson) as CanonicalEventV1),
    blobs = new Map(tuple.blobs.map((blob) => [blob.sha256, Buffer.from(blob.bodyBase64, "base64")])),
    readContentBlob = (sha256: string) => blobs.get(sha256) ?? null;
  return {
    read: () => ({ revision: events.length, events }),
    readHead: () => {
      const row = tuple.events.at(-1);
      return row ? { revision: row.revision, opId: row.opId, eventDigest: row.digest } : null;
    },
    readBatch: (after: string | null, limit: number) => {
      const from = Number(after ?? 0),
        batch = events.slice(from, from + limit),
        end = from + batch.length;
      return {
        sourceRevision: events.length,
        events: batch,
        cursor: end < events.length ? String(end) : null,
        done: end === events.length,
        accessedItems: batch.length,
        prefetchContent: (replay: readonly CanonicalEventV1[]) =>
          new Map(
            replay.flatMap((event) =>
              canonicalEventContentClaims(event).map(
                (claim) => [claim.sha256, readContentBlob(claim.sha256)!] as const,
              ),
            ),
          ),
      };
    },
    readContentBlob,
  } as unknown as CanonicalEventStore;
}
const fixedNow = () => "1970-01-01T00:00:00.000Z";
export async function withMigrationProjection<T>(
  repoId: string,
  tuple: Pick<MigrationTuple, "events" | "blobs">,
  read: (projection: TaskProjection) => T | Promise<T>,
): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), "ha-migration-projection-")),
    projection = makeTaskProjection({ rootDir: root, eventStore: migrationEventStream(repoId, tuple), now: fixedNow });
  try {
    projection.rebuild();
    return await read(projection);
  } finally {
    projection.close();
    /* @gate-identity state-store/migration.source.storage.src.migration.projection.filesystem-store */ rmSync(root, {
      recursive: true,
      force: true,
    });
  }
}
/** Logical rows include complete aggregates (reviews/consents/witnesses), entities and their freshness. */
export async function readMigrationProjection(projection: object): Promise<unknown> {
  const api = projection as Record<string, (...args: unknown[]) => unknown>,
    read = async (method: string, ...args: unknown[]) => await api[method]!(...args),
    result: Record<string, unknown> = {};
  for (const method of [
    "readCut",
    "listPinnedEntities",
    "readTaskStatuses",
    "readTaskRelations",
    "readRelationQuery",
    "readRuntimeInstallations",
    "readRuntimeSessions",
    "readSquadRuns",
    "listFactDomainTypes",
    "readFactAnchors",
    "readDecisionGraph",
    "readSettingsEvent",
  ])
    result[method] = await read(method);
  result.facts = await read("searchFacts", {});
  result.replicaBasis = await read("readReplicaBasis", null);
  result.documents = await Promise.all(
    (result.replicaBasis as { documents: { path: string }[] }).documents.map(
      async ({ path }) => await read("readDocument", path),
    ),
  );
  const events: CanonicalEventV1[] = [];
  let afterRevision = 0;
  for (;;) {
    const page = (await read("readCanonicalEvents", afterRevision, 500)) as {
      events: CanonicalEventV1[];
      sourceRevision: number;
    };
    events.push(...page.events);
    if (page.events.length === 0 || page.events.at(-1)!.workspaceRevision === page.sourceRevision) break;
    afterRevision = page.events.at(-1)!.workspaceRevision;
  }
  const refs = [...new Set(events.flatMap(canonicalEventEntityRefs))].sort();
  result.details = await Promise.all(
    refs.map(async (ref) => {
      const slash = ref.indexOf("/"),
        kind = ref.slice(0, slash),
        id = ref.slice(slash + 1);
      return {
        ref,
        version: await read("readEntityVersionWitness", ref),
        ...(kind === "fact" ? { fact: await read("readFact", id) } : {}),
        ...(kind === "decision"
          ? { decision: await read("readDecision", id), document: await read("readDecisionDocumentState", id) }
          : {}),
        artifact: await read("readArtifactEntityState", kind, id),
      };
    }),
  );
  result.entities = await Promise.all(
    entityKindContracts.map(async (contract) => [contract.kind, await read("listEntities", contract.kind)]),
  );
  const statuses = result.readTaskStatuses as { rows: { taskId: string }[] },
    tasks: unknown[] = [];
  for (const { taskId } of statuses.rows) {
    const snapshot = (await read("read", taskId)) as Record<string, unknown>;
    const { catchUp: _metrics, ...value } = snapshot;
    tasks.push({
      taskId,
      snapshot: value,
      progress: await read("readProgress", taskId),
      lease: await read("currentLease", taskId),
      intervals: await read("readLeaseIntervals", taskId),
    });
  }
  result.tasks = tasks;
  return { rows: result, digest: `sha256:${sha256Text(canonicalJson(result))}` };
}
export async function auditMigrationProjection(
  repoId: string,
  tuple: Pick<MigrationTuple, "events" | "blobs">,
  actual?: object,
  sqliteActual = false,
): Promise<unknown> {
  return withMigrationProjection(repoId, tuple, async (expected) => {
    const lifecycle = expected.readDispatchLifecycle({ by: "active", limit: DISPATCH_LIFECYCLE_PAGE_LIMIT });
    if (lifecycle.status !== "ready" || lifecycle.rows.length > 0)
      throw new StorageMigrationError("storage_migration_runtime_active", "in-flight runtime prevents freezing");
    for (const { taskId } of expected.readTaskStatuses().rows) {
      const lease = decideReadableTaskLease(expected.currentLease(taskId));
      if (lease)
        throw new StorageMigrationError(
          "storage_migration_lease_active",
          `unreleased lease ${lease.executionId} prevents freezing`,
        );
    }
    if (sqliteActual)
      assertMigrationValue(
        (actual as TaskProjection).readStateDigest(),
        expected.readStateDigest(),
        "complete SQLite projection rows differ from canonical replay",
      );
    const witness = await readMigrationProjection(expected);
    if (actual)
      assertMigrationValue(
        await readMigrationProjection(actual),
        witness,
        "projection rows, snapshots, freshness or authorization-visible state differ from canonical replay",
      );
    return witness;
  });
}
