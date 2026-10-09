import { canonicalDocumentClaims, canonicalDocumentRetirements } from "../composition/index.ts";
import { DEFAULT_TASK_ROOT_THRESHOLD } from "../domain/task-wip-policy.ts";
import { repositorySettings, type RepositorySettingsV1 } from "../domain/settings.ts";
import type { DatabaseSync } from "node:sqlite";
import { prepareQuery, runSql } from "./rebuildable-task-projection-sql.ts";
import { edgeReadModelEntries, readEdgeReadModelRows, READ_MODEL_META_PATH } from "./read-model.ts";
import { repositoryReadModelTables } from "./read-model-repository.ts";
import type { ReadModelSelection } from "./read-model-selection.ts";
import type { PersistedCanonicalEventV1, DocumentState } from "../domain/doc-sync.contract.ts";
import { serializePersistedCanonicalEvent } from "../domain/doc-sync.contract.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { serializeEventHead } from "../domain/write-chain.contract.ts";

export interface ReplicaBlob {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
}
export interface ReplicaEntry {
  readonly path: string;
  readonly blob: ReplicaBlob;
}
export type ReplicaChange =
  | { readonly op: "put"; readonly path: string; readonly blob: ReplicaBlob | null; readonly text: string | null }
  | { readonly op: "delete"; readonly path: string };
export interface ReplicaRevision {
  readonly revision: number;
  readonly headDigest: string;
  readonly occurredAt: string;
}
export interface ReplicaSequenceRead {
  readonly from: ReplicaRevision | null;
  readonly to: ReplicaRevision;
  readonly changes: readonly ReplicaChange[];
}

// The state digest replaces a full sorted-manifest hash. Each leaf binds path and blob;
// keyed entries are unique, and replacing a leaf removes its old contribution first.
export function updateReplicaManifestDigest(digest: string, entry: ReplicaEntry): string {
  return (BigInt(`0x${digest}`) ^ BigInt(`0x${sha256Text(stableStringify(entry))}`)).toString(16).padStart(64, "0");
}
export function replicaManifestDigest(entries: Iterable<ReplicaEntry>): string {
  let digest = "0".repeat(64);
  for (const entry of entries) digest = updateReplicaManifestDigest(digest, entry);
  return digest;
}

const groups = [
  { name: "task_snapshot", keys: ["task_id"], sources: ["task_snapshot", "task_package"] },
  { name: "task_generation", keys: ["task_id"] },
  { name: "task_progress", keys: ["task_id"] },
  { name: "entity_projection", keys: ["entity_kind", "task_id", "entity_id"] },
  { name: "lease_cas", keys: ["task_id"] },
  { name: "relation_edge", keys: ["relation_id"] },
  {
    name: "decision",
    keys: ["decision_id"],
    sources: [
      "decision",
      "decision_option",
      "decision_claim",
      "decision_judgment_consent",
      "decision_amendment",
      "decision_content_pin",
      "decision_review_event",
    ],
  },
  { name: "fact", keys: ["fact_id"] },
  { name: "preset_snapshot", keys: ["digest"] },
  ...repositoryReadModelTables.map((table) => ({ name: table.name, keys: table.keys })),
] as const;
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function createReplicaSequence(db: DatabaseSync): void {
  runSql(db, `CREATE TABLE IF NOT EXISTS replica_revision (revision INTEGER PRIMARY KEY, event_json TEXT NOT NULL)`);
  runSql(
    db,
    `CREATE TABLE IF NOT EXISTS replica_entry (path TEXT PRIMARY KEY, blob_json TEXT, text TEXT, group_name TEXT NOT NULL, group_key TEXT NOT NULL)`,
  );
  runSql(db, `CREATE INDEX IF NOT EXISTS replica_entry_group ON replica_entry(group_name, group_key)`);
  runSql(
    db,
    `CREATE TABLE IF NOT EXISTS replica_change (revision INTEGER NOT NULL, path TEXT NOT NULL, blob_json TEXT, text TEXT, PRIMARY KEY(revision,path))`,
  );
  runSql(db, `CREATE TEMP TABLE IF NOT EXISTS replica_dirty (group_name TEXT NOT NULL, group_key TEXT NOT NULL)`);
  for (const group of groups)
    for (const table of "sources" in group ? group.sources : [group.name])
      for (const [action, ref] of [
        ["INSERT", "NEW"],
        ["UPDATE", "NEW"],
        ["DELETE", "OLD"],
      ] as const)
        runSql(
          db,
          `CREATE TEMP TRIGGER IF NOT EXISTS replica_${table}_${action} AFTER ${action} ON main.${table} BEGIN INSERT INTO replica_dirty VALUES (${quote(group.name)}, json_array(${group.keys.map((key) => `${ref}.${key}`).join(",")})); END`,
        );
  runSql(
    db,
    `CREATE TEMP TRIGGER IF NOT EXISTS replica_settings_retirement AFTER UPDATE ON main.entity_projection WHEN OLD.entity_kind='settings' AND OLD.entity_id='repository' BEGIN INSERT INTO replica_dirty SELECT 'event_index', json_array(op_id) FROM event_index WHERE workspace_revision=OLD.workspace_revision; END`,
  );
}

export function readReplicaRevision(db: DatabaseSync, revision?: number): ReplicaRevision | null {
  const row =
    revision === undefined
      ? prepareQuery(db, "SELECT * FROM replica_revision ORDER BY revision DESC LIMIT 1").get()
      : prepareQuery(db, "SELECT * FROM replica_revision WHERE revision = ?").get(revision);
  if (!row) return null;
  const event = JSON.parse(String(row.event_json)) as PersistedCanonicalEventV1;
  return {
    revision: event.workspaceRevision,
    headDigest: `sha256:${sha256Text(serializeEventHead({ revision: event.workspaceRevision, opId: event.opId, eventDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(event))}` }))}`,
    occurredAt: event.occurredAt,
  };
}

export function readReplicaSequence(db: DatabaseSync, from: number | null): ReplicaSequenceRead | null {
  const to = readReplicaRevision(db);
  if (!to) return null;
  const base = from === null ? null : readReplicaRevision(db, from);
  if (from !== null && !base) return null;
  const changes = new Map<string, ReplicaChange>();
  const rows =
    from === null
      ? prepareQuery(db, "SELECT path, blob_json, text FROM replica_entry ORDER BY path").iterate()
      : prepareQuery(
          db,
          "SELECT path, blob_json, text FROM replica_change WHERE revision > ? AND revision <= ? ORDER BY revision,path",
        ).iterate(from, to.revision);
  for (const row of rows) {
    const itemPath = String(row.path);
    changes.set(
      itemPath,
      row.blob_json === null && row.text === null
        ? { op: "delete", path: itemPath }
        : {
            op: "put",
            path: itemPath,
            blob: row.blob_json === null ? null : (JSON.parse(String(row.blob_json)) as ReplicaBlob),
            text: row.text === null ? null : String(row.text),
          },
    );
  }
  return { from: base, to, changes: [...changes.values()] };
}

/** Called inside the transaction that reduces this canonical event, before its watermark commits. */
export function recordReplicaRevision(
  db: DatabaseSync,
  event: PersistedCanonicalEventV1,
  eventJson: string,
  previousRevision: number,
): void {
  // First activation exports the existing projection once, including installations with history.
  const initial = previousRevision === 0;
  const dirty = prepareQuery(
    db,
    "SELECT DISTINCT group_name, group_key FROM replica_dirty ORDER BY group_name,group_key",
  ).all();
  const selection = new Map<string, string>();
  for (const group of groups) {
    const keys = dirty.filter((row) => row.group_name === group.name).map((row) => String(row.group_key));
    const condition =
      keys
        .map((key) => {
          const values = JSON.parse(key) as (string | number)[];
          return `(${group.keys.map((column, index) => `${group.name}.${column} = ${typeof values[index] === "number" ? values[index] : quote(String(values[index]))}`).join(" AND ")})`;
        })
        .join(" OR ") || "0";
    for (const table of "sources" in group ? group.sources : [group.name])
      selection.set(table, condition.replaceAll(`${group.name}.`, `${table}.`));
  }
  const selected: ReadModelSelection | undefined = initial ? undefined : selection;
  const rows = readEdgeReadModelRows(db, selected);
  const meta = prepareQuery(db, "SELECT blob_json, text FROM replica_entry WHERE path=?").get(READ_MODEL_META_PATH);
  const settings = rows.entities.find((row) => row.entityKind === "settings" && row.entityId === "repository");
  const rootThreshold = settings
    ? repositorySettings(JSON.parse(settings.valueJson) as RepositorySettingsV1).tasks.rootThreshold
    : meta
      ? (JSON.parse(String(meta.text)) as { rootThreshold: number }).rootThreshold
      : DEFAULT_TASK_ROOT_THRESHOLD;
  const candidates = new Map<
    string,
    { entry: { path: string; blob: ReplicaBlob | null }; text: string | null; group: string; key: string }
  >();
  const resultPath = (ref: string) => {
    const digest = /^artifact:runtime-result\/sha256\/([a-f0-9]{64})$/u.exec(ref)?.[1];
    return digest ?? `ref-${sha256Text(ref)}`;
  };
  const unavailable = (ref: string) => {
    const suffix = resultPath(ref),
      itemPath = `.read-model/runtime-results-unavailable/${suffix}`;
    if (!prepareQuery(db, "SELECT 1 FROM replica_entry WHERE path=?").get(`.read-model/runtime-results/${suffix}`))
      candidates.set(itemPath, {
        entry: { path: itemPath, blob: null },
        text: stableStringify({ resultRef: ref, availability: "unavailable", downloadable: false }),
        group: "content",
        key: suffix,
      });
  };
  if (event.schema === "agent-runtime-event/v1" && event.type === "runtime_session_outcome_observed") {
    const claim = event.payload.result;
    if (claim) {
      const itemPath = `.read-model/runtime-results/${claim.sha256}`;
      candidates.set(itemPath, {
        entry: { path: itemPath, blob: { sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType } },
        text: null,
        group: "content",
        key: claim.sha256,
      });
    } else if (event.payload.resultRef) unavailable(event.payload.resultRef);
  }
  if (event.schema === "schedule-event/v1") {
    const detail = event.payload.schedule.status.lastRun?.detail;
    if (detail?.startsWith("artifact:runtime-result/")) unavailable(detail);
  }
  if (event.schema === "ci-run-observation/v4" && event.payload.detailRef) {
    const itemPath = `.read-model/ci-details/${event.eventId}.json`;
    candidates.set(itemPath, {
      entry: { path: itemPath, blob: null },
      text: JSON.stringify({ eventId: event.eventId, ref: event.payload.detailRef }),
      group: "content",
      key: event.eventId,
    });
  }
  const publishedRows = {
    ...rows,
    repository: (function* () {
      for (const row of rows.repository) {
        if (row.table !== "runtime_session") {
          yield row;
          continue;
        }
        const session = JSON.parse(String(row.values.value_json)) as { resultRef?: string };
        if (!session.resultRef) {
          yield row;
          continue;
        }
        const suffix = resultPath(session.resultRef),
          availablePath = `.read-model/runtime-results/${suffix}`,
          missingPath = `.read-model/runtime-results-unavailable/${suffix}`;
        const missing =
          !candidates.has(availablePath) &&
          (candidates.has(missingPath) ||
            prepareQuery(db, "SELECT 1 FROM replica_entry WHERE path=?").get(missingPath));
        yield missing
          ? {
              ...row,
              values: {
                ...row.values,
                value_json: stableStringify({
                  ...session,
                  resultAvailability: "unavailable",
                  resultDownloadable: false,
                }),
              },
            }
          : row;
      }
    })(),
  };
  for (const entry of edgeReadModelEntries({
    sourceRevision: event.workspaceRevision,
    rootThreshold,
    rows: publishedRows,
  })) {
    const blob = null;
    candidates.set(entry.path, { entry: { path: entry.path, blob }, text: entry.text, group: "model", key: "" });
  }
  if (initial)
    for (const row of prepareQuery(db, "SELECT path, value_json FROM document").iterate()) {
      const value = JSON.parse(String(row.value_json)) as DocumentState;
      candidates.set(value.path, {
        entry: { path: value.path, blob: { sha256: value.blobSha256, size: value.size, mediaType: value.mediaType } },
        text: null,
        group: "document",
        key: JSON.stringify([value.path]),
      });
    }
  else
    for (const claim of canonicalDocumentClaims(event))
      candidates.set(claim.path, {
        entry: { path: claim.path, blob: { sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType } },
        text: null,
        group: "document",
        key: JSON.stringify([claim.path]),
      });
  // A row's stable logical key belongs to exactly one touched group. Store that association
  // at serialization, so deleted rows can be retired without reading the old full manifest.
  for (const candidate of candidates.values())
    if (candidate.group === "model" && candidate.entry.path !== READ_MODEL_META_PATH) {
      const value = JSON.parse(candidate.text!) as Record<string, unknown>;
      let groupName: string, keys: unknown[];
      if (value.table) {
        groupName = String(value.table);
        const table = repositoryReadModelTables.find((table) => table.name === groupName)!;
        keys = table.keys.map((key) => (value.values as Record<string, unknown>)[key]);
      } else if (value.decisionId) {
        groupName = "decision";
        keys = [value.decisionId];
      } else if (value.factId) {
        groupName = "fact";
        keys = [value.factId];
      } else if (value.entityKind) {
        groupName = "entity_projection";
        keys = [value.entityKind, value.ownerId, value.entityId];
      } else if (value.relationId) {
        groupName = "relation_edge";
        keys = [value.relationId];
      } else if (value.digest) {
        groupName = "preset_snapshot";
        keys = [value.digest];
      } else {
        groupName =
          "snapshotJson" in value
            ? "task_snapshot"
            : "generation" in value
              ? "task_generation"
              : "entries" in value
                ? "task_progress"
                : "lease_cas";
        keys = [value.taskId];
      }
      candidate.group = groupName;
      candidate.key = JSON.stringify(keys);
    }
  const old = new Map<string, { blob: string | null; text: string | null }>();
  for (const row of dirty)
    for (const entry of prepareQuery(
      db,
      "SELECT path, blob_json, text FROM replica_entry WHERE group_name=? AND group_key=?",
    ).iterate(row.group_name, row.group_key))
      old.set(String(entry.path), { blob: entry.blob_json as string | null, text: entry.text as string | null });
  if (
    event.schema === "agent-runtime-event/v1" &&
    event.type === "runtime_session_outcome_observed" &&
    event.payload.result
  ) {
    const marker = `.read-model/runtime-results-unavailable/${event.payload.result.sha256}`;
    if (prepareQuery(db, "SELECT 1 FROM replica_entry WHERE path=?").get(marker))
      old.set(marker, { blob: null, text: null });
  }
  if (meta) old.set(READ_MODEL_META_PATH, { blob: null, text: String(meta.text) });
  for (const retired of canonicalDocumentRetirements(event)) old.set(retired.path, { blob: null, text: null });
  for (const itemPath of old.keys())
    if (!candidates.has(itemPath)) {
      runSql(db, "DELETE FROM replica_entry WHERE path=?", itemPath);
      runSql(db, "INSERT INTO replica_change VALUES (?, ?, NULL, NULL)", event.workspaceRevision, itemPath);
    }
  for (const { entry, text, group, key } of candidates.values()) {
    const prior = old.get(entry.path),
      blob = entry.blob === null ? null : stableStringify(entry.blob);
    if (prior && prior.blob === blob && prior.text === text) continue;
    runSql(db, "INSERT OR REPLACE INTO replica_entry VALUES (?, ?, ?, ?, ?)", entry.path, blob, text, group, key);
    runSql(db, "INSERT INTO replica_change VALUES (?, ?, ?, ?)", event.workspaceRevision, entry.path, blob, text);
  }
  runSql(db, "INSERT INTO replica_revision VALUES (?, ?)", event.workspaceRevision, eventJson);
  runSql(db, "DELETE FROM replica_revision WHERE revision <= ?", event.workspaceRevision - 64);
  runSql(db, "DELETE FROM replica_change WHERE revision <= ?", event.workspaceRevision - 63);
  runSql(db, "DELETE FROM replica_dirty");
}
