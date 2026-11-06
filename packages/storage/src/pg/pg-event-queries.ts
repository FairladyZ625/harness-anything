import { assertPgEventReadIndexReady } from "./pg-event-read-index-migration.ts";
import { assertPgProjectionSchemaVersion } from "./pg-projection-schema.ts";
import type { AgentRuntimeEventV1, CanonicalEventV1 } from "@harness-anything/kernel";
import { normalizeHistoricalEvent } from "@harness-anything/kernel/internal/domain/historical-event-normalization.ts";
import { withReviewerQualifiedDispatchKey } from "@harness-anything/kernel/internal/domain/event-shape-migration-event.ts";
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

/** SQLite event_index keeps accepted bytes unless the registered reviewer-key transform changes a dispatch. */
export function eventIndexEvent<Event extends CanonicalEventV1>(event: Event): Event {
  return withReviewerQualifiedDispatchKey(event) === event ? event : (normalizeHistoricalEvent(event) as Event);
}

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
              ? "event_schema = 'schedule-event/v1'"
              : "event_schema = 'schedule-event/v1' AND event_entity_id = $6",
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
          "event_type = $6 AND occurred_at >= $7 AND occurred_at <= $8",
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
              "executor_id = ANY($6::text[]) AND event_schema = ANY($7::text[])",
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
          "revision > $6 AND event_type <> ALL($7::text[]) AND runtime_session_id = $8",
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
        await assertPgEventReadIndexReady(client, claims, repoId);
        const cut = await readCutInTransaction(client, claims, readers, repoId),
          values: unknown[] = [claims.tenantId, claims.projectId, repoId, claims.policyEpoch, readers, cut.watermark],
          where = [
            "event.tenant_id=$1 AND event.project_id=$2 AND event.repo_id=$3 AND event.policy_epoch=$4",
            "(cardinality($5::text[])=0 OR event.readers && $5::text[])",
            "event.revision <= $6 AND event.event_type <> 'ci_run_observed'",
          ],
          add = (predicate: (parameter: number) => string, value: unknown) => {
            values.push(value);
            where.push(predicate(values.length));
          };
        if (query.revisionBound !== undefined)
          add((parameter) => `event.revision < $${parameter}`, query.revisionBound);
        if (query.type !== undefined) add((parameter) => `event.event_type = $${parameter}`, query.type);
        if (query.after !== undefined) add((parameter) => `event.occurred_at >= $${parameter}`, query.after);
        if (query.before !== undefined) add((parameter) => `event.occurred_at <= $${parameter}`, query.before);
        if (query.actor !== undefined)
          add((parameter) => `event.actor_refs @> ARRAY[$${parameter}]::text[]`, query.actor);
        if (query.entity !== undefined) add((parameter) => `ref.entity_ref = $${parameter}`, query.entity);
        values.push(query.limit + 1);
        // A scalar ref/revision range drives entity pages, including bare-id suffixes. Return
        // only the stored descriptor: submission event_json can contain an entire artifact set.
        const from =
            query.entity === undefined
              ? "ha_events AS event"
              : `ha_events AS event JOIN ha_event_entity_refs AS ref
            ON (ref.tenant_id,ref.project_id,ref.repo_id,ref.policy_epoch,ref.revision)
              = (event.tenant_id,event.project_id,event.repo_id,event.policy_epoch,event.revision)`,
          rows = await client.query<{ list_row: string }>(
            `SELECT event.list_row FROM ${from} WHERE ${where.join(" AND ")}
            ORDER BY ${query.entity === undefined ? "event" : "ref"}.revision DESC LIMIT $${values.length}`,
            values,
          ),
          selected = rows.rows.map(({ list_row }) => JSON.parse(list_row) as EventListRow);
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
  const readEventSummaries: PgTaskProjectionSource["readEventSummaries"] = (afterRevision, limit, fields) =>
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
        const cut = await readCutInTransaction(client, claims, readers, repoId);
        if (fields === "fleet") {
          // The fleet overview renders only a bounded header. `summary_json` is the fleet summary
          // computed in JS at write time (and backfilled for old rows): parsing a whole event with
          // jsonb would reject legal NUL bytes in provider strings, and shipping whole bodies would
          // charge one large historical event to a fixed page.
          const ready = await client.query(
            `SELECT 1 FROM ha_event_summary_state
             WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 AND ready
             LIMIT 1`,
            [claims.tenantId, claims.projectId, claims.policyEpoch, repoId],
          );
          if (!ready.rowCount) {
            // During the current/previous upgrade window, preserve the existing event reader
            // until this repo's bounded summary projection has been certified.
            const rows = await readEventRowsInTransaction(
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
              events: rows.map(({ event_json }) => canonicalEventSummary(JSON.parse(event_json) as CanonicalEventV1)),
            };
          }
          const result = await client.query<{ event_json: string }>(
            `SELECT summary_json AS event_json
             FROM ha_events
             WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 AND policy_epoch=$4
               AND event_type <> 'ci_run_observed'
               AND summary_json IS NOT NULL
               AND (cardinality($5::text[]) = 0 OR readers && $5::text[])
               AND revision <= $7 AND revision > $6
             ORDER BY revision ASC LIMIT $8`,
            [
              claims.tenantId,
              claims.projectId,
              repoId,
              claims.policyEpoch,
              readers,
              afterRevision,
              cut.watermark,
              limit,
            ],
          );
          return {
            ...cut,
            events: result.rows.map(
              ({ event_json }) =>
                canonicalEventSummary(JSON.parse(event_json) as CanonicalEventV1) as CanonicalEventSummary,
            ),
          };
        }
        const rows = await readEventRowsInTransaction(
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
              event: eventIndexEvent(JSON.parse(rows[0].event_json) as CanonicalEventV1),
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
  ).map(({ event_json }) => eventIndexEvent(JSON.parse(event_json) as CanonicalEventV1));
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
  await assertPgEventReadIndexReady(client, claims, repoId);
  const parameters = [claims.tenantId, claims.projectId, repoId, claims.policyEpoch, readers, ...predicateValues];
  if (limit !== undefined) parameters.push(limit);
  parameters.push(...suffixValues);
  const limitClause = limit === undefined ? "" : `LIMIT $${6 + predicateValues.length}`;
  return (
    await client.query<PgEventRow>(
      `SELECT revision::text, op_id, event_json FROM ha_events
       WHERE tenant_id = $1 AND project_id = $2 AND repo_id = $3 AND policy_epoch = $4
         AND event_type <> 'ci_run_observed'
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
