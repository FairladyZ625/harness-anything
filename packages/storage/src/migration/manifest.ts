import { taskProjectionSchemaVersion } from "../projection/projection-schema.ts";
import { parseCanonicalEvent } from "@harness-anything/kernel/internal/domain/doc-sync-canonical-events.ts";
import {
  canonicalEventContentClaims,
  canonicalLedgerCut,
} from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import { sha256Bytes, sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { canonicalJson } from "../projection/rebuildable-task-projection-sql.ts";
import { PG_PROJECTION_SCHEMA_VERSION } from "../pg/pg-projection-schema.ts";
import { StorageMigrationError, type StorageMigrationManifest, type MigrationTuple } from "./types.ts";

export const storageMigrationVersions = Object.freeze({
  eventSchema: 1 as const,
  reducer: 1 as const,
  projection: PG_PROJECTION_SCHEMA_VERSION,
  sqliteProjection: taskProjectionSchemaVersion,
});
export function sameMigrationValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
export function assertMigrationValue(left: unknown, right: unknown, message: string): void {
  if (!sameMigrationValue(left, right)) throw new StorageMigrationError("storage_migration_mismatch", message);
}
export function validateStorageManifest(manifest: StorageMigrationManifest): void {
  if (manifest.schema !== "storage-migration/v1" || !sameMigrationValue(manifest.versions, storageMigrationVersions))
    throw new StorageMigrationError(
      "storage_migration_version_unsupported",
      "unsupported event schema, reducer or projection version",
    );
  if (
    !/^[a-zA-Z0-9_-]{1,80}$/u.test(manifest.runId) ||
    !manifest.repoId ||
    manifest.source === manifest.target ||
    manifest.tuples.length === 0
  )
    throw new StorageMigrationError(
      "storage_migration_invalid",
      "migration needs a run identity and distinct endpoints",
    );
  const scopes = new Set<string>();
  for (const tuple of manifest.tuples) {
    const key = `${tuple.scope.tenantId}\0${tuple.scope.projectId}`;
    if (scopes.has(key)) throw new StorageMigrationError("storage_migration_invalid", "duplicate scope tuple");
    scopes.add(key);
    validateTuple(manifest.repoId, tuple);
  }
}
function validateTuple(repoId: string, tuple: MigrationTuple): void {
  const blobs = new Map(tuple.blobs.map((blob) => [blob.sha256, blob]));
  if (blobs.size !== tuple.blobs.length) throw new StorageMigrationError("storage_migration_invalid", "duplicate blob");
  for (const blob of tuple.blobs) {
    const bytes = Buffer.from(blob.bodyBase64, "base64");
    if (sha256Bytes(bytes) !== blob.sha256 || bytes.length !== blob.size)
      throw new StorageMigrationError("storage_migration_mismatch", `blob ${blob.sha256} differs`);
  }
  for (const [index, row] of tuple.events.entries()) {
    const event = parseCanonicalEvent(row.eventJson);
    if (
      row.revision !== index + 1 ||
      event.workspaceRevision !== row.revision ||
      event.opId !== row.opId ||
      event.occurredAt !== row.occurredAt ||
      row.digest !== `sha256:${sha256Text(row.eventJson)}`
    )
      throw new StorageMigrationError(
        "storage_migration_mismatch",
        `event bytes, digest or revision differ at ${index + 1}`,
      );
    for (const claim of canonicalEventContentClaims(event as never)) {
      const blob = blobs.get(claim.sha256);
      if (!blob || blob.size !== claim.size)
        throw new StorageMigrationError("storage_migration_mismatch", `missing blob ${claim.sha256}`);
    }
  }
  const last = tuple.events.at(-1);
  assertMigrationValue(
    tuple.cut,
    canonicalLedgerCut(repoId, last ? { revision: last.revision, opId: last.opId, eventDigest: last.digest } : null),
    "headDigest does not match final event",
  );
  const members = new Set<string>();
  for (const outcome of tuple.outcomes) {
    const rows =
      outcome.firstRevision === null ? [] : tuple.events.slice(outcome.firstRevision - 1, outcome.lastRevision!);
    assertMigrationValue(
      outcome.memberOpIds,
      rows.map((row) => row.opId),
      `command ${outcome.opId} membership differs`,
    );
    if (outcome.status === "rejected" && (rows.length > 0 || !outcome.rejectionCode))
      throw new StorageMigrationError("storage_migration_invalid", "rejected outcome has events or no rejection");
    for (const row of rows) {
      if (members.has(row.opId))
        throw new StorageMigrationError("storage_migration_invalid", "event belongs to multiple outcomes");
      members.add(row.opId);
    }
  }
  if (members.size !== tuple.events.length)
    throw new StorageMigrationError("storage_migration_invalid", "events are missing command outcomes");
}
export { assertSqliteMigrationScope } from "@harness-anything/kernel/internal/domain/storage-scope-policy.ts";
