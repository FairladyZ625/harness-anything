import type { Pool, PoolClient } from "pg";
import {
  serializePersistedCanonicalEvent,
  type CanonicalEventV1,
} from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import {
  TaskEventStoreError,
  canonicalEventEntityRefs,
  type CanonicalWriteBundle,
  type CanonicalEventStore,
} from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import { sha256Bytes, sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import {
  canonicalEventContentClaims,
  canonicalEventCut,
  canonicalLedgerCut,
  validateCanonicalWriteBundle,
} from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import { withPostgresTransaction, type PostgresScopeClaims } from "./transaction.ts";
import {
  assertAuthorizedReplacements,
  requiresReplacementAuthorization,
  type DocumentHead,
  type DocumentNode,
} from "../store/task-event-store-replacement-authorization.ts";
import {
  canonicalDocumentClaims,
  canonicalDocumentMode,
  canonicalDocumentRetirements,
} from "@harness-anything/kernel/internal/ports/canonical-document-claims.ts";

export interface PostgresEventStoreScope extends PostgresScopeClaims {
  readonly readers: readonly string[];
}
export interface PostgresAppendHooks {
  /** A4 may supply live authored bytes. Without a worktree, only canonical document bases are available. */
  readonly readAuthoredDocument?: (path: string) => DocumentNode | null | Promise<DocumentNode | null>;
  /** A3 updates its projection and watermark using this same transaction/client. Never commit here. */
  readonly project?: (
    client: PoolClient,
    value: { readonly revision: number; readonly events: readonly CanonicalEventV1[] },
  ) => Promise<void>;
}
export interface PostgresAppendResult {
  readonly outcome: OutcomeRow;
  readonly head: HeadRow;
  readonly replicationSequence: string | null;
  readonly replayed: boolean;
}
export type PostgresReadOperation = "head" | "events" | "event" | "outcome" | "content-blob";

export async function executePostgresRead(
  pool: Pool,
  scope: PostgresEventStoreScope,
  operation: PostgresReadOperation,
  payload: unknown,
): Promise<unknown> {
  return withPostgresTransaction(
    pool,
    async (client) => {
      switch (operation) {
        case "head":
          return (
            (
              await client.query<HeadRow>(
                "SELECT revision, head_op_id, head_event_digest, head_digest, writer_holder_id, writer_epoch, replication_history FROM ha_repo_heads WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3",
                [scope.tenantId, scope.projectId, (payload as { repoId: string }).repoId],
              )
            ).rows[0] ?? null
          );
        case "events":
          return readEvents(client, scope, payload as ReadEventsPayload);
        case "event":
          return readEvent(client, scope, payload as ReadEventPayload);
        case "outcome":
          return readOutcome(client, scope, payload as ReadOutcomePayload);
        case "content-blob":
          return readContentBlob(client, scope, payload as ReadContentBlobPayload);
      }
    },
    scope,
  );
}

interface PostgresAppendPayload {
  readonly repoId: string;
  readonly writerFence: { readonly repoId: string; readonly holderId: string; readonly epoch: number };
  readonly expectedRevision: number;
  readonly bundle?: CanonicalWriteBundle;
  readonly rejection?: Parameters<NonNullable<CanonicalEventStore["appendRejection"]>>[0];
}

interface ReadEventsPayload {
  readonly repoId: string;
  readonly query?: {
    readonly type?: string;
    readonly entity?: string;
    readonly actor?: string;
    readonly after?: string;
    readonly before?: string;
    readonly revisionBound?: number;
    readonly limit: number;
  };
  readonly afterRevision?: number;
  readonly limit?: number;
}
interface ReadEventPayload {
  readonly repoId: string;
  readonly key: "op_id" | "event_id" | "revision";
  readonly value: string | number;
}
interface ReadOutcomePayload {
  readonly repoId: string;
  readonly opId: string;
}
interface ReadContentBlobPayload {
  readonly sha256: string;
}

export async function executePostgresAppend(
  pool: Pool,
  scope: PostgresEventStoreScope,
  input: PostgresAppendPayload,
  hooks: PostgresAppendHooks = {},
  signal?: AbortSignal,
): Promise<PostgresAppendResult> {
  if ((input.bundle === undefined) === (input.rejection === undefined))
    throw new TaskEventStoreError("invalid_write_plan", "PostgreSQL append requires one bundle or rejection");
  const repoId = required(input.repoId, "repoId"),
    fence = input.writerFence;
  if (!fence || fence.repoId !== repoId || !fence.holderId || !Number.isSafeInteger(fence.epoch) || fence.epoch < 1)
    throw new TaskEventStoreError("revision_conflict", "writer epoch fence does not match the PostgreSQL repository");
  let committing = false;
  return withPostgresTransaction(
    pool,
    async (client) => {
      signal?.throwIfAborted();
      await client.query(
        `INSERT INTO ha_repo_heads (tenant_id, project_id, repo_id, revision, readers, policy_epoch)
           VALUES ($1,$2,$3,0,$4,$5) ON CONFLICT (tenant_id,project_id,repo_id) DO NOTHING`,
        [scope.tenantId, scope.projectId, repoId, scope.readers, scope.policyEpoch],
      );
      const locked = (
        await client.query<HeadRow>(
          `SELECT revision, head_op_id, head_event_digest, head_digest, writer_holder_id, writer_epoch, replication_history
           FROM ha_repo_heads WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 FOR UPDATE`,
          [scope.tenantId, scope.projectId, repoId],
        )
      ).rows[0];
      if (!locked)
        throw new TaskEventStoreError("revision_conflict", "PostgreSQL repository head is outside the active scope");

      // Validate the full declaration under the same lock as revision admission and every write.
      const prepared = input.bundle ? prepareBundle(input.bundle, repoId) : null,
        events = prepared?.events ?? [],
        blobs = prepared?.blobs ?? [],
        claims = prepared?.claims ?? [],
        opId = input.bundle?.event.opId ?? input.rejection!.opId,
        intentDigest = prepared?.intentDigest ?? input.rejection!.intentDigest,
        summary = input.bundle?.event.type ?? input.rejection!.summary,
        rejectionCode = input.rejection?.rejectionCode,
        genesisHeadDigest = canonicalLedgerCut(repoId, null).headDigest;

      const previous = (
        await client.query<OutcomeRow>(
          `SELECT op_id, status, first_revision, last_revision, intent_digest, intent_summary, rejection_code,
                  to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at, member_op_ids
           FROM ha_command_outcomes WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 AND op_id=$4`,
          [scope.tenantId, scope.projectId, repoId, opId],
        )
      ).rows[0];
      if (previous) {
        if (previous.intent_digest !== intentDigest)
          throw new TaskEventStoreError("op_conflict", `opId ${opId} already names another command intent`);
        return { outcome: previous, head: locked, replicationSequence: null, replayed: true };
      }

      const currentEpoch = Number(locked.writer_epoch);
      if (fence.epoch < currentEpoch)
        throw new TaskEventStoreError("revision_conflict", `writer epoch ${fence.epoch} is stale`);
      if (
        fence.epoch === currentEpoch &&
        locked.writer_holder_id !== null &&
        fence.holderId !== locked.writer_holder_id
      )
        throw new TaskEventStoreError("revision_conflict", `writer epoch ${fence.epoch} belongs to another holder`);
      const headRevision = Number(locked.revision);
      signal?.throwIfAborted();
      if (input.expectedRevision !== headRevision)
        throw new TaskEventStoreError(
          "revision_conflict",
          `expected revision ${input.expectedRevision} must equal current revision ${headRevision}`,
        );
      for (const [offset, event] of events.entries())
        if (event.revision !== headRevision + offset + 1)
          throw new TaskEventStoreError(
            "revision_conflict",
            `workspace revision ${event.revision} must equal allocated revision ${headRevision + offset + 1}`,
          );

      const members = input.bundle ? [...(input.bundle.preceding ?? []), input.bundle] : [];
      await authorizeReplacements(client, scope, repoId, members, hooks);

      for (const blob of blobs) {
        const bytes = Buffer.from(blob.bodyBase64, "base64");
        await client.query(
          `INSERT INTO ha_content_blobs (tenant_id,project_id,sha256,size,body,readers,policy_epoch)
             VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id,project_id,sha256) DO NOTHING`,
          [scope.tenantId, scope.projectId, blob.sha256, blob.size, bytes, scope.readers, scope.policyEpoch],
        );
      }
      for (const claim of claims) {
        const stored = (
          await client.query<{ readonly size: string; readonly body: Buffer }>(
            `SELECT size, body FROM ha_content_blobs WHERE tenant_id=$1 AND project_id=$2 AND sha256=$3`,
            [scope.tenantId, scope.projectId, claim.sha256],
          )
        ).rows[0];
        if (!stored || Number(stored.size) !== claim.size || sha256Bytes(stored.body) !== claim.sha256)
          throw new TaskEventStoreError(
            "invalid_write_plan",
            "canonical event references a missing or mismatched content blob",
          );
      }

      const recordedAt = new Date().toISOString();
      for (const event of events) {
        await client.query(
          `INSERT INTO ha_events
              (tenant_id,project_id,repo_id,revision,op_id,event_id,event_type,event_json,event_digest,occurred_at,
               actor_refs,entity_refs,readers,policy_epoch,recorded_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            scope.tenantId,
            scope.projectId,
            repoId,
            event.revision,
            event.opId,
            event.eventId,
            event.eventType,
            event.eventJson,
            event.eventDigest,
            event.occurredAt,
            event.actorRefs,
            event.entityRefs,
            scope.readers,
            scope.policyEpoch,
            recordedAt,
          ],
        );
        await updateDocumentHeads(client, scope, repoId, JSON.parse(event.eventJson) as CanonicalEventV1);
      }

      const finalEvent = events.at(-1),
        revision = finalEvent?.revision ?? headRevision,
        headOpId = finalEvent?.opId ?? locked.head_op_id,
        headEventDigest = finalEvent?.eventDigest ?? locked.head_event_digest,
        headDigest = finalEvent ? prepared!.headDigest : locked.head_digest;
      await client.query(
        `UPDATE ha_repo_heads SET revision=$4, head_op_id=$5, head_event_digest=$6, head_digest=$7,
             writer_holder_id=$8, writer_epoch=$9, readers=$10, policy_epoch=$11, updated_at=clock_timestamp()
           WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3`,
        [
          scope.tenantId,
          scope.projectId,
          repoId,
          revision,
          headOpId,
          headEventDigest,
          headDigest,
          fence.holderId,
          fence.epoch,
          scope.readers,
          scope.policyEpoch,
        ],
      );
      const outcome = {
        op_id: opId,
        status: rejectionCode === undefined ? "accepted_durable" : "rejected",
        first_revision: finalEvent ? events[0]!.revision : null,
        last_revision: finalEvent ? finalEvent.revision : null,
        intent_digest: intentDigest,
        intent_summary: summary,
        rejection_code: rejectionCode ?? null,
        recorded_at: recordedAt,
        member_op_ids: events.map(({ opId }) => opId),
      } satisfies OutcomeRow;
      await client.query(
        `INSERT INTO ha_command_outcomes
            (tenant_id,project_id,repo_id,op_id,status,first_revision,last_revision,intent_digest,intent_summary,
             rejection_code,recorded_at,member_op_ids,readers,policy_epoch)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          scope.tenantId,
          scope.projectId,
          repoId,
          outcome.op_id,
          outcome.status,
          outcome.first_revision,
          outcome.last_revision,
          outcome.intent_digest,
          outcome.intent_summary,
          outcome.rejection_code,
          recordedAt,
          outcome.member_op_ids,
          scope.readers,
          scope.policyEpoch,
        ],
      );
      await hooks.project?.(client, {
        revision,
        events: events.map(({ eventJson }) => JSON.parse(eventJson) as CanonicalEventV1),
      });
      signal?.throwIfAborted();
      const position = (
        await client.query<{ readonly sequence: string }>(
          `INSERT INTO ha_replication_positions
            (tenant_id,project_id,repo_id,sequence,revision,last_op_id,head_digest,writer_holder_id,writer_epoch,readers,policy_epoch,history)
           SELECT $1,$2,$3,COALESCE(MAX(sequence),0)+1,$4,$5,$6,$7,$8,$9,$10,$11
           FROM ha_replication_positions WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3
           RETURNING sequence`,
          [
            scope.tenantId,
            scope.projectId,
            repoId,
            revision,
            opId,
            headDigest ?? genesisHeadDigest,
            fence.holderId,
            fence.epoch,
            scope.readers,
            scope.policyEpoch,
            locked.replication_history,
          ],
        )
      ).rows[0]!;
      await client.query("SELECT pg_notify('ha_event_ledger_changed', $1)", [
        JSON.stringify({
          tenantId: scope.tenantId,
          projectId: scope.projectId,
          repoId,
          history: locked.replication_history,
          sequence: position.sequence,
          revision,
          headDigest,
        }),
      ]);
      signal?.throwIfAborted();
      committing = true;
      return {
        outcome,
        head: {
          revision,
          head_op_id: headOpId,
          head_event_digest: headEventDigest,
          head_digest: headDigest,
          writer_holder_id: fence.holderId,
          writer_epoch: fence.epoch,
          replication_history: locked.replication_history,
        },
        replicationSequence: position.sequence,
        replayed: false,
      };
    },
    scope,
  ).catch((error: unknown) => {
    if (committing)
      throw Object.assign(
        new TaskEventStoreError("publication_indeterminate", error instanceof Error ? error.message : String(error)),
        { cause: error },
      );
    throw error;
  });
}

/** Read the admission state on the locked transaction, then run the same rules as SQLite. */
async function authorizeReplacements(
  client: PoolClient,
  scope: PostgresEventStoreScope,
  repoId: string,
  members: readonly CanonicalWriteBundle[],
  hooks: PostgresAppendHooks,
): Promise<void> {
  if (!members.some(({ event }) => requiresReplacementAuthorization(event))) return;
  const paths = [
    ...new Set(
      members.flatMap(({ event }) => [
        ...canonicalDocumentClaims(event).map((claim) => claim.path),
        ...canonicalDocumentRetirements(event).map((claim) => claim.path),
      ]),
    ),
  ];
  const rows = (
    await client.query<{
      path: string;
      sha256: string | null;
      size: string | null;
      node_kind: DocumentHead["nodeKind"] | null;
      body: Buffer | null;
    }>(
      `SELECT head.path,head.sha256,head.size,head.node_kind,blob.body FROM ha_document_heads head
       LEFT JOIN ha_content_blobs blob ON blob.tenant_id=head.tenant_id AND blob.project_id=head.project_id AND blob.sha256=head.sha256
     WHERE head.tenant_id=$1 AND head.project_id=$2 AND head.repo_id=$3 AND head.path=ANY($4::text[])`,
      [scope.tenantId, scope.projectId, repoId, paths],
    )
  ).rows;
  const heads = new Map<string, DocumentHead | "retired">(),
    bodies = new Map<string, Uint8Array>(),
    local = new Map<string, DocumentNode | null>();
  for (const row of rows) {
    heads.set(
      row.path,
      row.sha256 === null ? "retired" : { sha256: row.sha256, size: Number(row.size), nodeKind: row.node_kind! },
    );
    if (row.sha256 !== null && row.body !== null) bodies.set(row.sha256, row.body);
  }
  for (const target of paths) local.set(target, (await hooks.readAuthoredDocument?.(target)) ?? null);
  const existing = new Set(
    (
      await client.query<{ op_id: string }>(
        "SELECT op_id FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 AND op_id=ANY($4::text[])",
        [scope.tenantId, scope.projectId, repoId, members.map(({ event }) => event.opId)],
      )
    ).rows.map((row) => row.op_id),
  );
  assertAuthorizedReplacements(
    {
      eventExists: (opId) => existing.has(opId),
      documentHead: (target) => heads.get(target),
      readContentObject: (sha256) => bodies.get(sha256) ?? null,
      local: (target) => local.get(target) ?? null,
    },
    members,
  );
}

async function updateDocumentHeads(
  client: PoolClient,
  scope: PostgresEventStoreScope,
  repoId: string,
  event: CanonicalEventV1,
): Promise<void> {
  const changes = [
    ...canonicalDocumentClaims(event).map((claim) => ({
      path: claim.path,
      sha256: claim.sha256,
      size: claim.size,
      nodeKind: canonicalDocumentMode(event, claim.path) === "120000" ? "symbolic-link" : "file",
    })),
    ...canonicalDocumentRetirements(event).map((claim) => ({
      path: claim.path,
      sha256: null,
      size: null,
      nodeKind: null,
    })),
  ];
  for (const change of changes)
    await client.query(
      `INSERT INTO ha_document_heads (tenant_id,project_id,repo_id,path,sha256,size,node_kind,revision,readers,policy_epoch)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tenant_id,project_id,repo_id,path) DO UPDATE SET sha256=EXCLUDED.sha256,size=EXCLUDED.size,
         node_kind=EXCLUDED.node_kind,revision=EXCLUDED.revision,readers=EXCLUDED.readers,policy_epoch=EXCLUDED.policy_epoch`,
      [
        scope.tenantId,
        scope.projectId,
        repoId,
        change.path,
        change.sha256,
        change.size,
        change.nodeKind,
        event.workspaceRevision,
        scope.readers,
        scope.policyEpoch,
      ],
    );
}

export interface HeadRow {
  readonly revision: string | number;
  readonly head_op_id: string | null;
  readonly head_event_digest: string | null;
  readonly head_digest: string | null;
  readonly writer_holder_id: string | null;
  readonly writer_epoch: string | number;
  readonly replication_history: string;
}
export interface OutcomeRow {
  readonly op_id: string;
  readonly status: "accepted_durable" | "rejected";
  readonly first_revision: string | number | null;
  readonly last_revision: string | number | null;
  readonly intent_digest: string;
  readonly intent_summary: string;
  readonly rejection_code: string | null;
  readonly recorded_at: string;
  readonly member_op_ids: readonly string[];
}

async function readEvents(client: PoolClient, scope: PostgresEventStoreScope, input: ReadEventsPayload) {
  const clauses = ["tenant_id=$1", "project_id=$2", "repo_id=$3"],
    values: unknown[] = [scope.tenantId, scope.projectId, input.repoId];
  const add = (clause: string, value: unknown) => {
    values.push(value);
    clauses.push(clause.replace("?", `$${values.length}`));
  };
  if (input.query) {
    const query = input.query;
    if (!Number.isSafeInteger(query.limit) || query.limit < 1)
      throw new TaskEventStoreError("invalid_store", "event query limit is invalid");
    if (query.type !== undefined) add("event_type=?", query.type);
    if (query.actor !== undefined) add("actor_refs @> ARRAY[?]::text[]", query.actor);
    if (query.after !== undefined) add("occurred_at>=?", query.after);
    if (query.before !== undefined) add("occurred_at<=?", query.before);
    if (query.revisionBound !== undefined) add("revision<?", query.revisionBound);
    if (query.entity !== undefined)
      add(
        query.entity.includes("/")
          ? "entity_refs @> ARRAY[?]::text[]"
          : "EXISTS (SELECT 1 FROM unnest(entity_refs) ref WHERE split_part(ref,'/',2)=?)",
        query.entity,
      );
    add("TRUE ORDER BY revision DESC LIMIT ?", query.limit);
  } else {
    if (
      !Number.isSafeInteger(input.afterRevision ?? 0) ||
      (input.afterRevision ?? 0) < 0 ||
      !Number.isSafeInteger(input.limit ?? 1) ||
      (input.limit ?? 1) < 1
    )
      throw new TaskEventStoreError("invalid_store", "event batch cursor or size is invalid");
    add("revision>?", input.afterRevision ?? 0);
    add("TRUE ORDER BY revision ASC LIMIT ?", input.limit ?? 2_147_483_647);
  }
  const result = await client.query<{ readonly event_json: string }>(
    `SELECT event_json FROM ha_events WHERE ${clauses.join(" AND ")}`,
    values,
  );
  return result.rows.map(({ event_json }) => event_json);
}

async function readEvent(client: PoolClient, scope: PostgresEventStoreScope, input: ReadEventPayload) {
  const columns = { op_id: "op_id", event_id: "event_id", revision: "revision" } as const,
    column = columns[input.key];
  if (!column) throw new TaskEventStoreError("invalid_store", "event lookup key is invalid");
  const row = (
    await client.query<{ readonly event_json: string }>(
      `SELECT event_json FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 AND ${column}=$4 ORDER BY revision LIMIT 1`,
      [scope.tenantId, scope.projectId, input.repoId, input.value],
    )
  ).rows[0];
  return row?.event_json ?? null;
}

async function readOutcome(client: PoolClient, scope: PostgresEventStoreScope, input: ReadOutcomePayload) {
  const row = (
    await client.query<OutcomeRow>(
      `SELECT op_id,status,first_revision,last_revision,intent_digest,intent_summary,rejection_code,
            to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at,member_op_ids
     FROM ha_command_outcomes WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3
       AND (op_id=$4 OR member_op_ids @> ARRAY[$4]::text[]) ORDER BY recorded_at LIMIT 1`,
      [scope.tenantId, scope.projectId, input.repoId, input.opId],
    )
  ).rows[0];
  return row ?? null;
}

async function readContentBlob(client: PoolClient, scope: PostgresEventStoreScope, input: ReadContentBlobPayload) {
  const row = (
    await client.query<{ readonly size: string; readonly body: Buffer }>(
      "SELECT size,body FROM ha_content_blobs WHERE tenant_id=$1 AND project_id=$2 AND sha256=$3",
      [scope.tenantId, scope.projectId, input.sha256],
    )
  ).rows[0];
  if (!row) return null;
  const body = Buffer.from(row.body);
  return body.toString("base64");
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new TaskEventStoreError("invalid_store", `PostgreSQL append requires ${label}`);
  return value;
}

function prepareBundle(bundle: CanonicalWriteBundle, repoId: string) {
  validateCanonicalWriteBundle(bundle);
  const members = [...(bundle.preceding ?? []), bundle],
    events = members.map(({ event }) => {
      const eventJson = serializePersistedCanonicalEvent(event);
      return {
        revision: event.workspaceRevision,
        opId: event.opId,
        eventId: event.eventId,
        eventType: event.type,
        eventJson,
        eventDigest: `sha256:${sha256Text(eventJson)}`,
        occurredAt: event.occurredAt,
        actorRefs: [event.actor.principal.personId, event.actor.executor?.id].filter(
          (value): value is string => !!value,
        ),
        entityRefs: canonicalEventEntityRefs(event),
      };
    }),
    claims = new Map<string, { readonly sha256: string; readonly size: number }>(),
    blobs = new Map<string, { readonly sha256: string; readonly size: number; readonly bodyBase64: string }>();
  // Individual bundle validation cannot detect conflicting claims across preceding members.
  for (const member of members) {
    for (const claim of canonicalEventContentClaims(member.event)) {
      const prior = claims.get(claim.sha256);
      if (prior && prior.size !== claim.size)
        throw new TaskEventStoreError("invalid_write_plan", "canonical bundle content claims conflict for one SHA");
      claims.set(claim.sha256, { sha256: claim.sha256, size: claim.size });
    }
    for (const blob of member.blobs) {
      const bodyBase64 = Buffer.from(blob.body).toString("base64");
      blobs.set(blob.sha256, { sha256: blob.sha256, size: blob.size, bodyBase64 });
    }
  }
  return {
    events,
    blobs: [...blobs.values()],
    claims: [...claims.values()],
    intentDigest: `sha256:${sha256Text(JSON.stringify(events.map(({ eventJson }) => eventJson)))}`,
    headDigest: canonicalEventCut(repoId, bundle.event).headDigest,
  };
}
