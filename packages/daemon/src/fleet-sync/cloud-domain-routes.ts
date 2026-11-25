import {
  listCanonicalDocuments,
  listProjectedTaskDocuments,
  readDocAction,
  readProjectedDocument,
  TASK_DOCUMENT_INLINE_BYTES_MAX,
} from "@harness-anything/application/internal/queries/doc-sync-reads.ts";
import {
  readCanonicalRuntimeResult,
  runtimeResultSha256,
} from "@harness-anything/application/internal/queries/runtime-result-read.ts";
import { readCollaboratorSchedules } from "@harness-anything/application/internal/queries/schedule-projection.ts";
import {
  readScheduleRuns,
  scheduleRunReportRefs,
} from "@harness-anything/application/internal/queries/schedule-runs-read.ts";
import {
  readSchedulesGui,
  scheduleActionFacet,
  type ScheduleGuiActionKind,
} from "@harness-anything/application/internal/queries/schedules-gui-read.ts";
import { makeSquadCanonicalReader } from "@harness-anything/application/internal/queries/squad-canonical-read.ts";
import {
  canonicalLedgerCut,
  documentPath,
  RAW_ARTIFACT_POLICY_ID,
  type CanonicalSquadRun,
} from "@harness-anything/kernel";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import type { PgTaskQueryMethods } from "../../../storage/src/pg/pg-task-query-contract.ts";
import type { PgTaskQueryReader } from "../../../storage/src/pg/pg-task-query-reader.ts";

export interface CloudDomainRouteContext {
  readonly repoId: string;
  readonly statelessRoot: string;
  readonly search: URLSearchParams;
  readonly personId: string;
}

export type CloudReaderRoute = (reader: PgTaskQueryReader, context: CloudDomainRouteContext) => unknown;

const TASK_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const DOC_RANGE_MAX_BYTES = 64 * 1024;
const DEFAULT_BACKUP_RETENTION = Object.freeze({ keepDays: 3, keepMonthly: true });

export function createCloudDomainRoutes(
  fault: (status: number, code: string) => Error,
): ReadonlyMap<string, CloudReaderRoute> {
  const optionalText = (search: URLSearchParams, key: string, maxLength = 256): string | undefined => {
    const value = search.get(key);
    if (value === null) return undefined;
    if (value.length === 0 || value.length > maxLength) throw fault(400, "invalid_command");
    return value;
  };

  const optionalBoolean = (search: URLSearchParams, key: string): boolean | undefined => {
    const value = search.get(key);
    if (value === null) return undefined;
    if (value === "true") return true;
    if (value === "false") return false;
    throw fault(400, "invalid_command");
  };

  const optionalInteger = (
    search: URLSearchParams,
    key: string,
    minimum: number,
    maximum: number,
  ): number | undefined => {
    const raw = search.get(key);
    if (raw === null) return undefined;
    if (!/^\d+$/u.test(raw)) throw fault(400, "invalid_command");
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw fault(400, "invalid_command");
    return value;
  };

  const requiredTaskId = (search: URLSearchParams): string => {
    const taskId = search.get("taskId");
    if (taskId === null || !TASK_ID.test(taskId)) throw fault(400, "invalid_task_id");
    return taskId;
  };

  const prefetchBlobs = (reader: PgTaskQueryReader, shas: readonly string[]): ReadonlyMap<string, Uint8Array> => {
    const blobs = new Map<string, Uint8Array>();
    for (const sha256 of new Set(shas)) {
      if (!SHA256_HEX.test(sha256)) continue;
      const bytes = reader.executeCanonical({ operation: "content", sha256 }) as Uint8Array | null;
      if (bytes !== null) blobs.set(sha256, bytes);
    }
    return blobs;
  };

  const blobStoreOf = (blobs: ReadonlyMap<string, Uint8Array>) => ({
    readContentBlob: (sha256: string): Uint8Array | null => blobs.get(sha256) ?? null,
    readContentBlobRange: (sha256: string, offset: number, maxBytes: number): Uint8Array | null => {
      const bytes = blobs.get(sha256);
      if (bytes === undefined) return null;
      return offset >= bytes.byteLength ? new Uint8Array(0) : bytes.subarray(offset, offset + maxBytes);
    },
    readContentBlobSize: (sha256: string): number | null => blobs.get(sha256)?.byteLength ?? null,
  });

  const prefetchSquadLeaderBlobs = (reader: PgTaskQueryReader, squadRunId: string): ReadonlyMap<string, Uint8Array> => {
    const shas = reader.withSession((queries: PgTaskQueryMethods) => {
      const row = queries.readSquadRun(squadRunId);
      if (!row) return [];
      const run = row.state as unknown as CanonicalSquadRun;
      const refs: string[] = [];
      for (const turn of run.leaderTurns) {
        const resultRef = queries.readRuntimeSession(turn.runtimeSessionId)?.resultRef;
        const sha = resultRef ? runtimeResultSha256(resultRef) : null;
        if (sha !== null) refs.push(sha);
      }
      return refs;
    });
    return prefetchBlobs(reader, shas);
  };

  return new Map<string, CloudReaderRoute>([
    [
      "doc-list",
      (reader, { search }) => {
        const { minimumRows, pageSizes } = storageReadPolicy.defaultValue;
        const prefix = search.get("prefix") ?? "";
        if (prefix.length > 512) throw fault(400, "invalid_command");
        const limit = optionalInteger(search, "limit", minimumRows, pageSizes.standard) ?? 100;
        const afterPath = optionalText(search, "afterPath", 512);
        const includeHistory = optionalBoolean(search, "includeHistory");
        const excludeTaskPackages = optionalBoolean(search, "excludeTaskPackages");
        return reader.withSession((queries: PgTaskQueryMethods) =>
          listCanonicalDocuments(queries, {
            prefix,
            limit,
            ...(afterPath === undefined ? {} : { afterPath }),
            ...(includeHistory === undefined ? {} : { includeHistory }),
            ...(excludeTaskPackages === undefined ? {} : { excludeTaskPackages }),
          }),
        );
      },
    ],
    [
      "doc-show",
      (reader, { repoId, statelessRoot, search, personId }) => {
        const rawPath = optionalText(search, "path", 512);
        if (rawPath === undefined) throw fault(400, "invalid_command");
        const raw = optionalBoolean(search, "raw");
        const offset = optionalInteger(search, "offset", 0, Number.MAX_SAFE_INTEGER);
        const length = optionalInteger(search, "length", 1, DOC_RANGE_MAX_BYTES);
        if ((offset === undefined) !== (length === undefined)) throw fault(400, "invalid_command");
        const contentSha256 = optionalText(search, "contentSha256", 128);
        const contentRevision = optionalInteger(search, "contentRevision", 0, Number.MAX_SAFE_INTEGER);
        if ((contentSha256 === undefined) !== (contentRevision === undefined)) throw fault(400, "invalid_command");
        const head = reader.executeCanonical({ operation: "head" }) as Parameters<typeof canonicalLedgerCut>[1];
        const currentCut = canonicalLedgerCut(repoId, head);
        let logical: string;
        try {
          logical = documentPath(rawPath);
        } catch {
          throw fault(400, "invalid_command");
        }
        const blobSha =
          offset === undefined
            ? null
            : reader.withSession((queries: PgTaskQueryMethods) => {
                const active = queries.readDocument(logical);
                const doc = active.document ?? queries.readDocumentHistory?.(logical).document ?? null;
                return doc?.blobSha256 ?? null;
              });
        const blobs = blobSha === null ? new Map<string, Uint8Array>() : prefetchBlobs(reader, [blobSha]);
        const store = {
          currentCut: () => currentCut,
          ...blobStoreOf(blobs),
        };
        return reader.withSession((queries: PgTaskQueryMethods) =>
          readDocAction({
            action: {
              kind: "doc-show",
              path: logical,
              ...(raw === true ? { raw: true } : {}),
              ...(offset === undefined ? {} : { offset, length }),
              ...(contentSha256 === undefined ? {} : { contentSha256, contentRevision }),
            },
            binding: {
              actor: { principal: { personId }, executor: null },
              source: "local",
            },
            rootDir: statelessRoot,
            store,
            projection: queries,
            nodeTaskMaterializationPolicy: "none",
            now: () => new Date().toISOString(),
          }),
        );
      },
    ],
    [
      "task-documents",
      (reader, { search }) => {
        const taskId = requiredTaskId(search);
        return reader.withSession((queries: PgTaskQueryMethods) => listProjectedTaskDocuments(queries, { taskId }));
      },
    ],
    [
      "task-document",
      (reader, { statelessRoot, search }) => {
        const taskId = requiredTaskId(search);
        const requested = optionalText(search, "path", 512);
        if (requested === undefined) throw fault(400, "invalid_command");
        const view = optionalText(search, "view", 32);
        const binaryBlobSha = reader.withSession((queries: PgTaskQueryMethods) => {
          const task = queries.read(taskId);
          if (!task.packagePath) return null;
          let logical: string;
          try {
            logical = documentPath(`${task.packagePath}/${requested}`);
          } catch {
            throw fault(400, "invalid_command");
          }
          const doc = queries.readDocument(logical).document;
          if (
            doc !== null &&
            doc.policyId === RAW_ARTIFACT_POLICY_ID &&
            Number(doc.size) <= TASK_DOCUMENT_INLINE_BYTES_MAX
          )
            return doc.blobSha256;
          return null;
        });
        const blobs = binaryBlobSha === null ? new Map<string, Uint8Array>() : prefetchBlobs(reader, [binaryBlobSha]);
        const store = blobStoreOf(blobs);
        return reader.withSession((queries: PgTaskQueryMethods) =>
          readProjectedDocument(
            {
              rootDir: statelessRoot,
              projection: queries,
              store,
            },
            {
              taskId,
              path: requested,
              ...(view === undefined ? {} : { view }),
            },
          ),
        );
      },
    ],
    [
      "squad-runs",
      (reader, { search }) => {
        const { minimumRows, pageSizes } = storageReadPolicy.defaultValue;
        const since = optionalText(search, "since", 64);
        const query = optionalText(search, "query", 256);
        const limit = optionalInteger(search, "limit", minimumRows, pageSizes.standard);
        const personId = optionalText(search, "personId", 128);
        const nodeId = optionalText(search, "nodeId", 128);
        const payload = {
          ...(since === undefined ? {} : { since }),
          ...(query === undefined ? {} : { query }),
          ...(limit === undefined ? {} : { limit }),
          ...(personId === undefined ? {} : { personId }),
          ...(nodeId === undefined ? {} : { nodeId }),
        };
        return reader.withSession((queries: PgTaskQueryMethods) =>
          makeSquadCanonicalReader({
            projection: queries,
            readResult: () => {
              throw fault(503, "replica_unavailable");
            },
          }).list(payload),
        );
      },
    ],
    [
      "squad-run",
      (reader, { search }) => {
        const squadRunId = optionalText(search, "squadRunId", 128);
        if (squadRunId === undefined) throw fault(400, "invalid_squad_run_id");
        const blobs = prefetchSquadLeaderBlobs(reader, squadRunId);
        const store = blobStoreOf(blobs);
        return reader.withSession((queries: PgTaskQueryMethods) =>
          makeSquadCanonicalReader({
            projection: queries,
            readResult: (ref) => readCanonicalRuntimeResult(store, ref),
          }).read(squadRunId),
        );
      },
    ],
    [
      "squad-run-status",
      (reader, { search }) => {
        const squadRunId = optionalText(search, "squadRunId", 128);
        if (squadRunId === undefined) throw fault(400, "invalid_squad_run_id");
        const blobs = prefetchSquadLeaderBlobs(reader, squadRunId);
        const store = blobStoreOf(blobs);
        return reader.withSession((queries: PgTaskQueryMethods) =>
          makeSquadCanonicalReader({
            projection: queries,
            readResult: (ref) => readCanonicalRuntimeResult(store, ref),
          }).status(squadRunId),
        );
      },
    ],
    [
      "schedules",
      (reader, { repoId, search }) => {
        const scopePersonId = optionalText(search, "scopePersonId", 128);
        const filterPersonId = optionalText(search, "filterPersonId", 128);
        const filterNodeId = optionalText(search, "filterNodeId", 128);
        const hasScope = scopePersonId !== undefined || filterPersonId !== undefined || filterNodeId !== undefined;
        return reader.withSession((queries: PgTaskQueryMethods) => {
          const selected = hasScope
            ? readCollaboratorSchedules(queries, {
                ...(scopePersonId === undefined ? {} : { scopePersonId }),
                ...(filterPersonId === undefined ? {} : { filterPersonId }),
                ...(filterNodeId === undefined ? {} : { filterNodeId }),
              })
            : undefined;
          return readSchedulesGui(
            {
              mode: "remote-center",
              repoId,
              now: () => new Date().toISOString(),
              projection: queries,
              ports: {
                admitAction: cloudScheduleActionFacet,
                runtimeInstances: () => [],
                defaultBackupRetention: DEFAULT_BACKUP_RETENTION,
              },
            },
            selected,
          );
        });
      },
    ],
    [
      "schedule-runs",
      (reader, { search }) => {
        const scheduleId = optionalText(search, "scheduleId", 256);
        if (scheduleId === undefined) throw fault(400, "invalid_command");
        const { minimumRows, pageSizes } = storageReadPolicy.defaultValue;
        const limit = optionalInteger(search, "limit", minimumRows, pageSizes.standard);
        const shas = reader.withSession((queries: PgTaskQueryMethods) => {
          if (!queries.getEntity("schedule", scheduleId)) return [];
          return scheduleRunReportRefs(queries, scheduleId, limit)
            .map(runtimeResultSha256)
            .filter((sha): sha is string => sha !== null);
        });
        const blobs = prefetchBlobs(reader, shas);
        const store = blobStoreOf(blobs);
        return reader.withSession((queries: PgTaskQueryMethods) =>
          readScheduleRuns({ projection: queries, store }, scheduleId, limit),
        );
      },
    ],
  ]);
}

function cloudScheduleActionFacet(actionKind: ScheduleGuiActionKind) {
  if (actionKind === "schedule-run-now") return scheduleActionFacet(false, "repo_mode_requires_center_ingress");
  return scheduleActionFacet(true, null);
}
