import path from "node:path";
import { readAuthoredNode } from "../authored-node-read.ts";
import { resolvePostgresEventStoreScope } from "../pg/backend.ts";
import {
  createPgTaskQueryReader,
  type PgQueryConnectionOptions,
  type PgTaskQueryReader,
} from "../pg/pg-task-query-reader.ts";
import {
  serializePersistedCanonicalEvent,
  type LedgerCommitSha,
} from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { canonicalDocumentClaims } from "@harness-anything/kernel/internal/ports/canonical-document-claims.ts";
import { isTaskEvent } from "@harness-anything/kernel/internal/domain/doc-sync-canonical-events.ts";
import { resolveHarnessLayout } from "@harness-anything/kernel/internal/layout/index.ts";
import type { CanonicalEventV1 } from "@harness-anything/kernel";
import type { HarnessLayoutInput } from "@harness-anything/kernel/internal/layout/index.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import {
  canonicalEventCut,
  canonicalLedgerCut,
} from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import {
  TaskEventStoreError,
  type CanonicalEventStore,
  type CanonicalCommandOutcome,
  type CanonicalEventAppendReceipt,
  type MaterializationHealth,
  type MaterializationReceipt,
  type MaterializationRequest,
} from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import { validateContentRange } from "../content-blob-range.ts";
import type { PGliteStorageBackendConfig, PostgresStorageBackendConfig } from "../storage-backend.ts";
import type { PostgresTaskEventStoreOptions, PGliteTaskEventStoreOptions } from "../store/task-event-store-factory.ts";

export interface PgGitFollowerHandle {
  readonly currentCommit: () => LedgerCommitSha | null;
  readonly followerStatus: CanonicalEventStore["followerStatus"];
  readonly materialize: CanonicalEventStore["materialize"];
  readonly materializationHealth: CanonicalEventStore["materializationHealth"];
  readonly settlePendingMaterialization: NonNullable<CanonicalEventStore["settlePendingMaterialization"]>;
  readonly request: () => void;
  readonly drain: () => Promise<void>;
}

export interface PgGitFollowerMountContext {
  readonly options: PostgresTaskEventStoreOptions | PGliteTaskEventStoreOptions;
  readonly rootInput: HarnessLayoutInput | undefined;
  readonly reader: PgTaskQueryReader;
  readonly head: CanonicalEventStore["readHead"];
  readonly readContentBlob: CanonicalEventStore["readContentBlob"];
  readonly writable: () => void;
  readonly acceptedRetired: () => ReadonlyMap<string, string>;
  readonly retainRetiredPaths: (settledPaths?: readonly string[]) => void;
  readonly checkpointSource: {
    readonly metadata: () => { readonly repoId: string; readonly generation: number; readonly revision: number };
    readonly eventIdentityAtRevision: (revision: number) => {
      readonly revision: number;
      readonly opId: string;
      readonly eventDigest: `sha256:${string}`;
    } | null;
  };
}

export type PgSqlQueryReaderFactory = (
  options: Omit<PgQueryConnectionOptions, "scope"> & {
    readonly storage: PostgresStorageBackendConfig | PGliteStorageBackendConfig;
    readonly requireRuntimeRole?: boolean;
    readonly epochAuthority?: boolean;
  },
) => PgTaskQueryReader;

export type PgCanonicalEventStoreOptions = (PostgresTaskEventStoreOptions | PGliteTaskEventStoreOptions) & {
  /** Override query reader owner (e.g. PGlite injection from @harness-anything/storage/pglite). */
  readonly createReader?: PgSqlQueryReaderFactory;
  /** Optional host/legacy Git follower attachment. Pure PG writer-cells omit this to stay subprocess-free. */
  readonly attachGitFollower?: (context: PgGitFollowerMountContext) => PgGitFollowerHandle;
};

/**
 * One handle belongs to the single writer. Its synchronous bridge waits only inside DB SyncRep TX;
 * concurrent reads open independent product reader handles on another thread.
 */
export function makePgCanonicalEventStore(options: PgCanonicalEventStoreOptions): CanonicalEventStore & {
  readonly pruneReplicationLog: (beforeSequence: number) => void;
  readonly readDocumentRetirementRevision: (path: string) => number | null;
} {
  const rootInput = options.rootInput ?? options.rootDir,
    authoredRoot = rootInput === undefined ? undefined : resolveHarnessLayout(rootInput).authoredRoot,
    reader = options.createReader
      ? options.createReader({
          storage: options.storage,
          repoId: options.repoId,
          requireRuntimeRole: true,
          ...(authoredRoot === undefined ? {} : { authoredRoot }),
        })
      : openPostgresOnlyReader({
          storage: options.storage,
          repoId: options.repoId,
          requireRuntimeRole: true,
          ...(authoredRoot === undefined ? {} : { authoredRoot }),
        }),
    execute = reader.executeCanonical,
    head: CanonicalEventStore["readHead"] = () =>
      execute({ operation: "head" }) as ReturnType<CanonicalEventStore["readHead"]>,
    checkpointSource = {
      metadata: () => ({ repoId: options.repoId, generation: 3, revision: head()?.revision ?? 0 }),
      eventIdentityAtRevision: (revision: number) => {
        const event = execute({ operation: "event", key: "revision", value: revision }) as CanonicalEventV1 | null;
        return event
          ? {
              revision: event.workspaceRevision,
              opId: event.opId,
              eventDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(event))}` as const,
            }
          : null;
      },
    },
    readContentBlob: CanonicalEventStore["readContentBlob"] = (sha256) =>
      execute({ operation: "content", sha256 }) as Uint8Array | null,
    readContentBlobRange: CanonicalEventStore["readContentBlobRange"] = (sha256, offset, maxBytes) => {
      validateContentRange(offset, maxBytes);
      return execute({ operation: "content-range", sha256, offset, maxBytes }) as Uint8Array | null;
    },
    readContentBlobSize: CanonicalEventStore["readContentBlobSize"] = (sha256) =>
      execute({ operation: "content-size", sha256 }) as number | null,
    readEvent: CanonicalEventStore["readEvent"] = (value) =>
      execute({ operation: "event", key: "op_id", value }) as CanonicalEventV1 | null,
    writable = () => {
      if (options.mutable === false) throw new TaskEventStoreError("invalid_write_plan", "event reader is read-only");
    },
    fence = () => options.writerFence?.() ?? { repoId: options.repoId, holderId: "direct-store", epoch: 1 };
  let acceptedRetired = new Map<string, string>();

  const gitFollower = options.attachGitFollower?.({
    options,
    rootInput,
    reader,
    head,
    readContentBlob,
    writable,
    acceptedRetired: () => acceptedRetired,
    retainRetiredPaths: (settledPaths) => {
      if (!settledPaths) {
        acceptedRetired = new Map();
        return;
      }
      const settled = new Set(settledPaths);
      acceptedRetired = new Map([...acceptedRetired].filter(([logical]) => !settled.has(logical)));
    },
    checkpointSource,
  });

  const emptyHealth = (): MaterializationHealth => {
    const revision = head()?.revision ?? 0;
    return {
      state: "ok",
      lastCheckpointRevision: revision,
      lastCheckpointAt: null,
      pendingWalEvents: 0,
    };
  };

  return {
    canonicalRef: "postgres:canonical",
    read: () => execute({ operation: "stream" }) as ReturnType<CanonicalEventStore["read"]>,
    readHead: head,
    currentCut: () => canonicalLedgerCut(options.repoId, head()),
    currentCommit: () => (gitFollower ? gitFollower.currentCommit() : null),
    publication: (event) => ({ commitSha: null, cut: canonicalEventCut(options.repoId, event) }),
    readEvent,
    readEventAtRevision: (value) => execute({ operation: "event", key: "revision", value }) as CanonicalEventV1 | null,
    readEventById: (value) => execute({ operation: "event", key: "event_id", value }) as CanonicalEventV1 | null,
    readDocumentRetirementRevision: (path) =>
      execute({ operation: "document-retirement-revision", path }) as number | null,
    queryEvents: (query) => execute({ operation: "events", query }) as readonly CanonicalEventV1[],
    readEntityDeclarations: (query) =>
      execute({ operation: "entity-declarations", query }) as ReturnType<
        NonNullable<CanonicalEventStore["readEntityDeclarations"]>
      >,
    readTaskEvent: (opId) => {
      const event = readEvent(opId);
      return event && isTaskEvent(event) ? event : null;
    },
    readCommandOutcome: (opId) => execute({ operation: "outcome", opId }) as CanonicalCommandOutcome | null,
    ledgerMetadata: () => ({ repoId: options.repoId, generation: 3, revision: head()?.revision ?? 0 }),
    followerStatus: () =>
      gitFollower
        ? gitFollower.followerStatus()
        : {
            git: { status: "pending", cut: null, commitSha: null, reason: "Git follower is host-managed" },
            worktree: { status: "pending", cut: null, commitSha: null, reason: "Git follower is host-managed" },
          },
    readBatch: (cursor, maxItems) =>
      execute({ operation: "batch", cursor, maxItems }) as ReturnType<CanonicalEventStore["readBatch"]>,
    readContentBlob,
    readContentBlobRange,
    readContentBlobSize,
    layout: () => "sharded-sha256-2/v1",
    append: (bundle) => {
      writable();
      const appendAuthoredRoot = rootInput === undefined ? null : resolveHarnessLayout(rootInput).authoredRoot,
        acceptedClaims = new Map<string, string>();
      if (appendAuthoredRoot !== null)
        for (const member of [...(bundle.preceding ?? []), bundle])
          for (const claim of canonicalDocumentClaims(member.event)) {
            const node = readAuthoredNode(path.join(appendAuthoredRoot, ...claim.path.split("/")));
            if (node?.isFile && node.sha256 === claim.sha256) acceptedClaims.set(claim.path, claim.sha256);
          }
      const receipt = options.canonicalWriter
        ? options.canonicalWriter.append(bundle)
        : (execute({
            operation: "append",
            bundle,
            expectedRevision: bundle.preceding?.[0]?.event.workspaceRevision
              ? bundle.preceding[0].event.workspaceRevision - 1
              : bundle.event.workspaceRevision - 1,
            writerFence: fence(),
          }) as CanonicalEventAppendReceipt);
      for (const [logical, digest] of acceptedClaims) acceptedRetired.set(logical, digest);
      gitFollower?.request();
      return receipt;
    },
    appendRejection: (rejection) => {
      writable();
      if (options.canonicalWriter) return options.canonicalWriter.appendRejection(rejection);
      return execute({
        operation: "reject",
        rejection,
        expectedRevision: head()?.revision ?? 0,
        writerFence: fence(),
      }) as CanonicalCommandOutcome;
    },
    materialize: (request?: MaterializationRequest): MaterializationReceipt =>
      gitFollower
        ? gitFollower.materialize(request)
        : { status: request?.preview ? "planned" : "visible", commitSha: null, settlements: [], conflicts: [] },
    materializationHealth: () => (gitFollower ? gitFollower.materializationHealth() : emptyHealth()),
    settlePendingMaterialization: async (context) => {
      if (gitFollower) await gitFollower.settlePendingMaterialization(context);
    },
    drain: async () => {
      if (gitFollower) await gitFollower.drain();
      reader.close();
    },
    pruneReplicationLog: (beforeSequence) => {
      writable();
      if (options.canonicalWriter) options.canonicalWriter.pruneReplicationLog(beforeSequence);
      else execute({ operation: "prune", beforeSequence, writerFence: fence() });
    },
  };
}

function openPostgresOnlyReader(
  options: Omit<PgQueryConnectionOptions, "scope"> & {
    readonly storage: PostgresStorageBackendConfig | PGliteStorageBackendConfig;
    readonly requireRuntimeRole?: boolean;
    readonly epochAuthority?: boolean;
  },
): PgTaskQueryReader {
  if (options.storage.backend !== "postgres") {
    throw new Error("makePgCanonicalEventStore requires createReader injection for non-Postgres SQL backends");
  }
  const { storage, requireRuntimeRole, epochAuthority, ...connection } = options;
  return createPgTaskQueryReader({
    ...connection,
    scope: resolvePostgresEventStoreScope(storage.scope),
    connectionString: storage.connectionString,
    authorityConnectionString: epochAuthority ? storage.authorityConnectionString : undefined,
    requireRuntimeRole,
  });
}
