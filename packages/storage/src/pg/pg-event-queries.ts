import { assertPgProjectionSchemaVersion } from "./pg-projection-schema.ts";
import type { AgentRuntimeEventV1, CanonicalEventV1 } from "@harness-anything/kernel";
import { canonicalEventEntityRefs } from "@harness-anything/kernel";
import { normalizeHistoricalEvent } from "@harness-anything/kernel/internal/domain/historical-event-normalization.ts";
import { isAgentRuntimeEvent } from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import {
  privateRuntimeEventTypes,
  publicRuntimeDispatch,
} from "@harness-anything/kernel/internal/domain/runtime-public-query.ts";
import type { EventListRow } from "@harness-anything/kernel/internal/domain/event-list.ts";
import {
  canonicalEventSummary,
  type CanonicalEventSummary,
} from "@harness-anything/kernel/internal/domain/canonical-event-summary.ts";
import { isTaskEvent } from "@harness-anything/kernel/internal/domain/doc-sync-canonical-events.ts";
import { withPostgresTransaction, type PostgresScopeClaims } from "../postgres/transaction.ts";
import type { PgTaskProjectionSourceOptions, PgTaskProjectionSource, PgProjectionCut } from "./pg-task-source.ts";

export function pgEventQueries(options: PgTaskProjectionSourceOptions) {
  const claims: PostgresScopeClaims = options.scope,
    readers = [...(options.scope.readers ?? [])],
    repoId = options.repoId;
  const readCanonicalEvents: PgTaskProjectionSource["readCanonicalEvents"] = (afterRevision, pageLimit) =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        if (
          !Number.isSafeInteger(afterRevision) ||
          afterRevision < 0 ||
          !Number.isSafeInteger(pageLimit) ||
          pageLimit < 1 ||
          pageLimit > 500
        )
          throw new Error("canonical event page requires a non-negative revision and a limit from 1 to 500");
        const cut = await readCutInTransaction(client, claims, readers, repoId),
          events = await readEventsInTransaction(
            client,
            claims,
            readers,
            repoId,
            "revision > $6",
            [afterRevision],
            "LIMIT $7",
            [pageLimit],
          );
        return { ...cut, events };
      },
      claims,
      { isolationLevel: "repeatable read" },
    );
  const readScheduleEvents: PgTaskProjectionSource["readScheduleEvents"] = (scheduleId) =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        const cut = await readCutInTransaction(client, claims, readers, repoId),
          events = await readEventsInTransaction(
            client,
            claims,
            readers,
            repoId,
            scheduleId === undefined
              ? "event_json::jsonb ->> 'schema' = 'schedule-event/v1'"
              : "event_json::jsonb ->> 'schema' = 'schedule-event/v1' AND event_json::jsonb #>> '{entity,id}' = $6",
            scheduleId === undefined ? [] : [scheduleId],
          );
        return { ...cut, events };
      },
      claims,
      { isolationLevel: "repeatable read" },
    );
  const readReckoningEvents: PgTaskProjectionSource["readReckoningEvents"] = ({ type, after, before }) =>
    withPostgresTransaction(
      options.pool,
      (client) =>
        readEventsInTransaction(
          client,
          claims,
          readers,
          repoId,
          "event_type = $6 AND event_json::jsonb ->> 'occurredAt' >= $7 AND event_json::jsonb ->> 'occurredAt' <= $8",
          [type, after, before],
        ),
      claims,
      { isolationLevel: "repeatable read" },
    );
  const readScheduleOutputEvents: PgTaskProjectionSource["readScheduleOutputEvents"] = (runtimeSessionIds) =>
    withPostgresTransaction(
      options.pool,
      (client) =>
        runtimeSessionIds.length === 0
          ? Promise.resolve([])
          : readEventsInTransaction(
              client,
              claims,
              readers,
              repoId,
              "event_json::jsonb #>> '{actor,executor,id}' = ANY($6::text[]) AND event_json::jsonb ->> 'schema' = ANY($7::text[])",
              [
                runtimeSessionIds.map((id) => `runtime-session:${id}`),
                ["fact-event/v1", "decision-event/v1", "task-event/v1"],
              ],
            ),
      claims,
      { isolationLevel: "repeatable read" },
    );
  const readRuntimeSessionEvents: PgTaskProjectionSource["readRuntimeSessionEvents"] = (
    runtimeSessionId,
    afterRevision,
    limit,
  ) =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        if (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || !Number.isSafeInteger(limit) || limit < 1)
          throw new Error("runtime session event page requires a non-negative revision and a positive limit");
        const events = await readEventsInTransaction(
          client,
          claims,
          readers,
          repoId,
          "revision > $6 AND event_type <> ALL($7::text[]) AND event_json::jsonb #>> '{payload,runtimeSessionId}' = $8",
          [afterRevision, privateRuntimeEventTypes, runtimeSessionId],
          "LIMIT $9",
          [limit],
        );
        return events
          .filter((event): event is AgentRuntimeEventV1 => isAgentRuntimeEvent(event))
          .map((event) => (event.type === "runtime_dispatch_requested" ? publicRuntimeDispatch(event) : event));
      },
      claims,
      { isolationLevel: "repeatable read" },
    );
  const readEventList: PgTaskProjectionSource["readEventList"] = (query) =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 500)
          throw new Error("event list limit must be between 1 and 500");
        const cut = await readCutInTransaction(client, claims, readers, repoId),
          values: unknown[] = [cut.watermark],
          where = ["revision <= $6"],
          add = (predicate: (parameter: number) => string, value: unknown) => {
            values.push(value);
            where.push(predicate(values.length + 5));
          };
        if (query.revisionBound !== undefined) add((parameter) => `revision < $${parameter}`, query.revisionBound);
        if (query.type !== undefined) add((parameter) => `event_type = $${parameter}`, query.type);
        if (query.after !== undefined) add((parameter) => `occurred_at >= $${parameter}`, query.after);
        if (query.before !== undefined) add((parameter) => `occurred_at <= $${parameter}`, query.before);
        if (query.actor !== undefined) add((parameter) => `actor_refs @> ARRAY[$${parameter}]::text[]`, query.actor);
        if (query.entity !== undefined)
          add(
            (parameter) =>
              `EXISTS (SELECT 1 FROM unnest(entity_refs) ref WHERE ref = $${parameter} OR right(ref, char_length($${parameter}) + 1) = '/' || $${parameter})`,
            query.entity,
          );
        const rows = await readEventRowsInTransaction(
          client,
          claims,
          readers,
          repoId,
          where.join(" AND "),
          values,
          "DESC",
          query.limit + 1,
        );
        const selected = rows.map(({ revision, event_json }) => {
          const event = JSON.parse(event_json) as CanonicalEventV1;
          return {
            revision: Number(revision),
            opId: event.opId,
            eventId: event.eventId,
            schema: event.schema,
            type: event.type,
            occurredAt: event.occurredAt,
            actor: {
              personId: event.actor.principal.personId,
              executorId: event.actor.executor?.id ?? null,
            },
            entityRefs: canonicalEventEntityRefs(event),
          } satisfies EventListRow;
        });
        const result = selected.slice(0, query.limit),
          hasMore = selected.length > query.limit;
        return { rows: result, hasMore, nextCursor: hasMore && result.length ? String(result.at(-1)!.revision) : null };
      },
      claims,
      { isolationLevel: "repeatable read" },
    );
  const readEventWitness: PgTaskProjectionSource["readEventWitness"] = (revision) =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        const cut = await readCutInTransaction(client, claims, readers, repoId),
          rows = await readEventRowsInTransaction(client, claims, readers, repoId, "revision = $6 AND revision <= $7", [
            revision,
            cut.watermark,
          ]);
        if (!rows[0]) return null;
        const event = JSON.parse(rows[0].event_json) as CanonicalEventV1;
        return {
          workspaceRevision: event.workspaceRevision,
          occurredAt: event.occurredAt,
          actor: event.actor,
          source: event.source,
        };
      },
      claims,
      { isolationLevel: "repeatable read" },
    );
  const readEventSummaries: PgTaskProjectionSource["readEventSummaries"] = (afterRevision, limit) =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        if (
          !Number.isSafeInteger(afterRevision) ||
          afterRevision < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 2048
        )
          throw new Error("event summary page requires a non-negative revision and a limit from 1 to 2048");
        const cut = await readCutInTransaction(client, claims, readers, repoId),
          rows = await readEventRowsInTransaction(
            client,
            claims,
            readers,
            repoId,
            "revision > $6 AND revision <= $7",
            [afterRevision, cut.watermark],
            "ASC",
            limit,
          );
        return {
          ...cut,
          events: rows.map(
            ({ event_json }) =>
              canonicalEventSummary(JSON.parse(event_json) as CanonicalEventV1) as CanonicalEventSummary,
          ),
        };
      },
      claims,
      { isolationLevel: "repeatable read" },
    );
  const readOperation: PgTaskProjectionSource["readOperation"] = (opId) =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        const cut = await readCutInTransaction(client, claims, readers, repoId),
          rows = await readEventRowsInTransaction(client, claims, readers, repoId, "op_id = $6 AND revision <= $7", [
            opId,
            cut.watermark,
          ]);
        return rows[0]
          ? {
              event: normalizeHistoricalEvent(JSON.parse(rows[0].event_json)) as CanonicalEventV1,
              watermark: cut.watermark,
            }
          : null;
      },
      claims,
      { isolationLevel: "repeatable read" },
    );
  const readTaskOperation: PgTaskProjectionSource["readTaskOperation"] = (opId) =>
    withPostgresTransaction(
      options.pool,
      async (client) => {
        const cut = await readCutInTransaction(client, claims, readers, repoId),
          rows = await readEventRowsInTransaction(client, claims, readers, repoId, "op_id = $6 AND revision <= $7", [
            opId,
            cut.watermark,
          ]);
        if (!rows[0]) return null;
        const event = JSON.parse(rows[0].event_json) as CanonicalEventV1;
        return isTaskEvent(event) ? { event, watermark: cut.watermark } : null;
      },
      claims,
      { isolationLevel: "repeatable read" },
    );
  return {
    readCanonicalEvents,
    readScheduleEvents,
    readReckoningEvents,
    readScheduleOutputEvents,
    readRuntimeSessionEvents,
    readEventList,
    readEventWitness,
    readEventSummaries,
    readOperation,
    readTaskOperation,
  };
}

async function readEventsInTransaction(
  client: import("pg").PoolClient,
  claims: PostgresScopeClaims,
  readers: readonly string[],
  repoId: string,
  predicate: string,
  predicateValues: readonly unknown[] = [],
  suffix = "",
  suffixValues: readonly unknown[] = [],
): Promise<CanonicalEventV1[]> {
  return (
    await readEventRowsInTransaction(
      client,
      claims,
      readers,
      repoId,
      predicate,
      predicateValues,
      "ASC",
      undefined,
      suffix,
      suffixValues,
    )
  ).map(({ event_json }) => normalizeHistoricalEvent(JSON.parse(event_json)) as CanonicalEventV1);
}

interface PgEventRow {
  readonly revision: string;
  readonly op_id: string;
  readonly event_json: string;
}

export async function readEventRowsInTransaction(
  client: import("pg").PoolClient,
  claims: PostgresScopeClaims,
  readers: readonly string[],
  repoId: string,
  predicate: string,
  predicateValues: readonly unknown[] = [],
  order: "ASC" | "DESC" = "ASC",
  limit?: number,
  suffix = "",
  suffixValues: readonly unknown[] = [],
): Promise<PgEventRow[]> {
  const parameters = [claims.tenantId, claims.projectId, repoId, claims.policyEpoch, readers, ...predicateValues];
  if (limit !== undefined) parameters.push(limit);
  parameters.push(...suffixValues);
  const limitClause = limit === undefined ? "" : `LIMIT $${6 + predicateValues.length}`;
  return (
    await client.query<PgEventRow>(
      `SELECT revision::text, op_id, event_json FROM ha_events
       WHERE tenant_id = $1 AND project_id = $2 AND repo_id = $3 AND policy_epoch = $4
         AND (cardinality($5::text[]) = 0 OR readers && $5::text[])
         AND revision <= (SELECT watermark FROM ha_projection_meta WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$4 AND projection_name='task/v1') AND ${predicate}
       ORDER BY ha_events.revision ${order} ${suffix} ${limitClause}`,
      parameters,
    )
  ).rows;
}

export async function readCutInTransaction(
  client: import("pg").PoolClient,
  claims: PostgresScopeClaims,
  readers: readonly string[],
  repoId: string,
): Promise<PgProjectionCut> {
  const result = await client.query<{ watermark: string; schema_version: number }>(
    `SELECT watermark::text,schema_version FROM ha_projection_meta
     WHERE tenant_id = $1 AND project_id = $2 AND policy_epoch = $3 AND projection_name = 'task/v1'`,
    [claims.tenantId, claims.projectId, claims.policyEpoch],
  );
  assertPgProjectionSchemaVersion(result.rows[0]?.schema_version);
  const head = await client.query<{ readonly revision: string }>(
    `SELECT revision::text FROM ha_repo_heads
     WHERE tenant_id = $1 AND project_id = $2 AND repo_id = $3 AND policy_epoch = $4
       AND (cardinality($5::text[]) = 0 OR readers && $5::text[])`,
    [claims.tenantId, claims.projectId, repoId, claims.policyEpoch, readers],
  );
  const watermark = Number(result.rows[0]?.watermark ?? 0),
    sourceRevision = Number(head.rows[0]?.revision ?? 0);
  if (watermark > sourceRevision)
    throw new Error(`projection watermark ${watermark} exceeds ledger head ${sourceRevision}`);
  return { status: watermark === sourceRevision ? "ready" : "pending", watermark, sourceRevision };
}
