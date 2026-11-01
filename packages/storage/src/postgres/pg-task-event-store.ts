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
  | { readonly operation: "head" }
  | {
      readonly operation: "events";
      readonly afterRevision?: number;
      readonly limit?: number;
      readonly query?: CanonicalEventQuery;
    }
  | { readonly operation: "event"; readonly key: "op_id" | "event_id" | "revision"; readonly value: string | number }
  | { readonly operation: "outcome"; readonly opId: string }
  | { readonly operation: "content"; readonly sha256: string };
export type PostgresTaskEventStoreResult =
  | CanonicalEventAppendReceipt
  | CanonicalCommandOutcome
  | ReturnType<CanonicalEventStore["readHead"]>
  | readonly CanonicalEventV1[]
  | CanonicalEventV1
  | Uint8Array;

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
  if (
    !repoId ||
    !scope.tenantId ||
    !scope.projectId ||
    !Number.isSafeInteger(scope.policyEpoch) ||
    scope.policyEpoch < 0 ||
    scope.readers.some((reader) => !reader)
  )
    throw new TypeError(
      "PostgreSQL event store requires repoId, tenantId, projectId, readers, and a non-negative policyEpoch scope",
    );

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
    }
  };
  return { append, readHead, execute, currentCut: async () => canonicalLedgerCut(repoId, await readHead()) };
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
