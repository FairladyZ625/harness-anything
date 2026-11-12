import { assertPostgresStoreScope } from "@harness-anything/kernel/internal/domain/storage-scope-policy.ts";
import { readPgEntityDeclarations } from "../pg/pg-entity-declarations.ts";
import {
  freezeDeclaredWritePlan,
  type WritePlan,
} from "@harness-anything/kernel/internal/domain/write-chain.contract.ts";
import type { Pool } from "pg";
import type { CanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import {
  canonicalEventCut,
  canonicalLedgerCut,
} from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import {
  type CanonicalCommandOutcome,
  type CanonicalEventAppendReceipt,
  type CanonicalEventQuery,
  type CanonicalEventStore,
  type CanonicalWriteBundle,
  type CanonicalEventWriteBundle,
} from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import {
  executePostgresAppend,
  executePostgresRead,
  type HeadRow,
  type OutcomeRow,
  type PostgresAppendHooks,
  type PostgresEventStoreScope,
} from "./pg-event-store.ts";
import { withPostgresTransaction } from "./transaction.ts";
import { migrationWritable } from "../migration/types.ts";
import { TaskEventStoreError } from "@harness-anything/kernel";

export interface PostgresWriterFence {
  readonly repoId: string;
  readonly holderId: string;
  readonly epoch: number;
}
type Rejection = Parameters<NonNullable<CanonicalEventStore["appendRejection"]>>[0];
type TransportMember = Omit<CanonicalEventWriteBundle, "plan"> & { readonly plan: WritePlan };
/** Structured clone preserves declarations, but deliberately does not preserve Object.freeze. */
type TransportBundle = TransportMember & { readonly preceding?: readonly TransportMember[] };
export type PostgresTaskEventStoreRequest =
  | {
      readonly operation: "append";
      readonly bundle: TransportBundle;
      readonly expectedRevision: number;
      readonly writerFence: PostgresWriterFence;
    }
  | {
      readonly operation: "reject";
      readonly rejection: Rejection;
      readonly expectedRevision: number;
      readonly writerFence: PostgresWriterFence;
    }
  | {
      readonly operation: "entity-declarations";
      readonly query: import("@harness-anything/kernel/internal/ports/entity-declarations.ts").EntityDeclarationReadQuery;
    }
  | { readonly operation: "head" }
  | { readonly operation: "prune"; readonly beforeSequence: number; readonly writerFence: PostgresWriterFence }
  | { readonly operation: "stream" }
  | { readonly operation: "batch"; readonly cursor: string | null; readonly maxItems: number }
  | {
      readonly operation: "events";
      readonly afterRevision?: number;
      readonly limit?: number;
      readonly query?: CanonicalEventQuery;
    }
  | { readonly operation: "event"; readonly key: "op_id" | "event_id" | "revision"; readonly value: string | number }
  | { readonly operation: "outcome"; readonly opId: string }
  | { readonly operation: "content"; readonly sha256: string }
  | { readonly operation: "content-range"; readonly sha256: string; readonly offset: number; readonly maxBytes: number }
  | { readonly operation: "content-size"; readonly sha256: string };
export type PostgresTaskEventStoreResult =
  | readonly import("@harness-anything/kernel/internal/ports/entity-declarations.ts").EntityDeclarationState[]
  | CanonicalEventAppendReceipt
  | CanonicalCommandOutcome
  | ReturnType<CanonicalEventStore["readHead"]>
  | readonly CanonicalEventV1[]
  | CanonicalEventV1
  | Uint8Array
  | number
  | null
  | ReturnType<CanonicalEventStore["read"]>
  | ReturnType<CanonicalEventStore["readBatch"]>;

export interface PostgresTaskEventCapabilityOptions extends PostgresAppendHooks {
  /** Borrowed from the async host. A4 owns pool creation, drain, and close. */
  readonly pool: Pool;
  readonly repoId: string;
  readonly scope: PostgresEventStoreScope;
}

/** Whole operations for the RepoWriter host. This never pretends an async driver is a sync kernel port. */
export function makePostgresTaskEventStore(options: PostgresTaskEventCapabilityOptions) {
  const { pool, repoId } = options,
    scope = { ...options.scope, readers: [...new Set(options.scope.readers)].sort() };
  assertPostgresStoreScope(repoId, scope);

  const readHead = async () => {
    const row = (await executePostgresRead(pool, scope, "head", { repoId })) as HeadRow | null;
    return !row || Number(row.revision) === 0
      ? null
      : {
          revision: Number(row.revision),
          opId: row.head_op_id!,
          eventDigest: row.head_event_digest as `sha256:${string}`,
        };
  };
  const append = async (
    bundle: CanonicalWriteBundle,
    expectedRevision: number,
    writerFence: PostgresWriterFence,
    signal?: AbortSignal,
  ): Promise<CanonicalEventAppendReceipt> => {
    signal?.throwIfAborted();
    await executePostgresAppend(pool, scope, { repoId, writerFence, expectedRevision, bundle }, options, signal);
    return {
      status: "applied",
      event: bundle.event,
      revision: bundle.event.workspaceRevision,
      commitSha: null,
      cut: canonicalEventCut(repoId, bundle.event),
      metrics: { gitProcesses: 0, nodeSyncs: 0, changedPaths: [] },
    };
  };
  const execute = async (
    request: PostgresTaskEventStoreRequest,
    signal?: AbortSignal,
  ): Promise<PostgresTaskEventStoreResult> => {
    signal?.throwIfAborted();
    switch (request.operation) {
      case "prune":
        await withPostgresTransaction(
          pool,
          async (client) => {
            const keys = [scope.tenantId, scope.projectId, repoId],
              row = (
                await client.query<{
                  writer_epoch: string;
                  writer_holder_id: string;
                  migration_control: Parameters<typeof migrationWritable>[0];
                }>(
                  "UPDATE ha_repo_heads SET revision=revision WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 RETURNING writer_epoch,writer_holder_id,migration_control",
                  keys,
                )
              ).rows[0];
            if (
              !row ||
              !migrationWritable(row.migration_control) ||
              Number(row.writer_epoch) !== request.writerFence.epoch ||
              row.writer_holder_id !== request.writerFence.holderId
            )
              throw new TaskEventStoreError("revision_conflict", "replication pruning writer epoch is stale");
            await client.query(
              "DELETE FROM ha_replication_positions WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 AND sequence<$4 AND sequence<(SELECT MAX(sequence) FROM ha_replication_positions WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3)",
              [...keys, request.beforeSequence],
            );
          },
          scope,
        );
        return null;
      case "stream":
      case "batch":
        return (await executePostgresRead(pool, scope, request.operation, {
          ...request,
          repoId,
        })) as PostgresTaskEventStoreResult;
      case "append":
        return append(freezeTransportBundle(request.bundle), request.expectedRevision, request.writerFence, signal);
      case "reject": {
        const { rejection, expectedRevision, writerFence } = request;
        const result = await executePostgresAppend(
          pool,
          scope,
          { repoId, writerFence, expectedRevision, rejection },
          options,
          signal,
        );
        return commandOutcome(result.outcome);
      }
      case "head":
        return readHead();
      case "entity-declarations":
        return withPostgresTransaction(
          pool,
          (client) => readPgEntityDeclarations(client, scope, repoId, request.query),
          scope,
          { isolationLevel: "repeatable read" },
        );
      case "events": {
        const rows = (await executePostgresRead(pool, scope, "events", { ...request, repoId })) as readonly string[];
        return rows.map((body) => JSON.parse(body) as CanonicalEventV1);
      }
      case "event": {
        const body = (await executePostgresRead(pool, scope, "event", { ...request, repoId })) as string | null;
        return body === null ? null : (JSON.parse(body) as CanonicalEventV1);
      }
      case "outcome": {
        const row = (await executePostgresRead(pool, scope, "outcome", { ...request, repoId })) as OutcomeRow | null;
        return row === null ? null : commandOutcome(row);
      }
      case "content": {
        const body = (await executePostgresRead(pool, scope, "content-blob", request)) as string | null;
        return body === null ? null : Uint8Array.from(Buffer.from(body, "base64"));
      }
      case "content-range":
        return (await executePostgresRead(pool, scope, "content-blob-range", request)) as Uint8Array | null;
      case "content-size":
        return (await executePostgresRead(pool, scope, "content-blob-size", request)) as number | null;
      default:
        return assertNever(request);
    }
  };
  return { append, readHead, execute, currentCut: async () => canonicalLedgerCut(repoId, await readHead()) };
}

function assertNever(value: never): never {
  throw new TypeError(`unsupported PostgreSQL event store operation: ${JSON.stringify(value)}`);
}

function commandOutcome(row: OutcomeRow): CanonicalCommandOutcome {
  return {
    opId: row.op_id,
    status: row.status,
    firstRevision: row.first_revision === null ? null : Number(row.first_revision),
    lastRevision: row.last_revision === null ? null : Number(row.last_revision),
    recordedAt: row.recorded_at,
    memberOpIds: [...row.member_op_ids],
  };
}

function freezeTransportBundle(bundle: TransportBundle): CanonicalWriteBundle {
  const freeze = (member: TransportMember): CanonicalEventWriteBundle => ({
    ...member,
    plan: freezeDeclaredWritePlan(member.plan, [member.plan.commandType]),
  });
  return { ...freeze(bundle), ...(bundle.preceding ? { preceding: bundle.preceding.map(freeze) } : {}) };
}
