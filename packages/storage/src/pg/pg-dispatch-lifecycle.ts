// Postgres half of the dispatch lifecycle read model: the same kernel reducer, folded in the
// canonical event transaction into generic projection values. No lifecycle state is inferred in SQL.
// Admission is decided by the center writer before the append; the fold records a rejected event as
// ignored, exactly like the SQLite fold, so canonical history (including imported or migrated
// events) always replays. A projection written before this model existed (or by another model
// version) carries an older `dispatch_lifecycle_version` in its meta row: reads are pending until
// the backfill refolds it from the canonical events through the same reducer.
import type { Pool, PoolClient } from "pg";
import {
  DISPATCH_LIFECYCLE_MODEL_VERSION,
  DISPATCH_LIFECYCLE_PAGE_LIMIT,
  currentDispatchAttempt,
  dispatchGroupIsActive,
  dispatchLifecycleAddress,
  dispatchLifecycleTaskId,
  dispatchLifecycleView,
  isDispatchLifecycleInput,
  reduceDispatchLifecycle,
  taskLeaseAfter,
  type DispatchLifecycleGroup,
  type DispatchLifecycleInput,
  type DispatchLifecycleQuery,
  type DispatchLifecycleRead,
  type DispatchTaskLease,
} from "@harness-anything/kernel/internal/domain/dispatch-lifecycle.ts";
import { withPostgresTransaction, type PostgresScopeClaims } from "../postgres/transaction.ts";
import { deletePgProjectionValue, getPgProjectionValue, putPgProjectionValue } from "./pg-projection-values.ts";
import { readCutInTransaction } from "./pg-event-queries.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";

const GROUP = "dispatch-lifecycle-group",
  SESSION = "dispatch-lifecycle-session",
  DISPATCH = "dispatch-lifecycle-dispatch",
  ACTIVE = "dispatch-lifecycle-active",
  EXECUTION = "dispatch-lifecycle-execution",
  TASK_CAS_CONTEXT = "dispatch-lifecycle-task-lease";
const MODELS = [GROUP, SESSION, DISPATCH, ACTIVE, EXECUTION, TASK_CAS_CONTEXT] as const;

/** Fold one event; a rejected step leaves the group unchanged. */
export async function projectPgDispatchLifecycle(
  client: PoolClient,
  scope: PgProjectionScope,
  event: { readonly schema: string; readonly type: string },
): Promise<void> {
  if (!isDispatchLifecycleInput(event)) return;
  const input = event as DispatchLifecycleInput,
    revision = input.workspaceRevision,
    taskId = dispatchLifecycleTaskId(input),
    context = {
      taskLease:
        taskId === null ? null : await getPgProjectionValue<DispatchTaskLease>(client, scope, TASK_CAS_CONTEXT, taskId),
    },
    address = dispatchLifecycleAddress(input, context),
    groupIds =
      address === null
        ? []
        : address.by === "group"
          ? [address.attemptGroupId]
          : address.by === "session"
            ? [await getPgProjectionValue<string>(client, scope, SESSION, address.runtimeSessionId)]
            : await activeGroupsForExecutions(client, scope, address.executionIds);
  for (const groupId of groupIds) {
    const previous =
        groupId === null ? null : await getPgProjectionValue<DispatchLifecycleGroup>(client, scope, GROUP, groupId),
      step = reduceDispatchLifecycle(previous, input, context);
    if (step.kind === "applied") await writeGroup(client, scope, previous, step.group, revision);
  }
  const lease = taskLeaseAfter(input);
  if (lease === null && taskId !== null) await deletePgProjectionValue(client, scope, TASK_CAS_CONTEXT, taskId);
  else if (lease && taskId !== null)
    await putPgProjectionValue(client, scope, TASK_CAS_CONTEXT, taskId, "", revision, lease);
}

async function activeGroupsForExecutions(
  client: PoolClient,
  scope: PgProjectionScope,
  executionIds: readonly string[],
): Promise<readonly string[]> {
  const result = await client.query<{ entity_id: string }>(
    `SELECT entity_id FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
     AND model='${EXECUTION}' AND owner_id = ANY($4::text[]) ORDER BY entity_id COLLATE "C"`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, [...executionIds]],
  );
  return result.rows.map(({ entity_id }) => entity_id);
}

async function writeGroup(
  client: PoolClient,
  scope: PgProjectionScope,
  previous: DispatchLifecycleGroup | null,
  group: DispatchLifecycleGroup,
  revision: number,
): Promise<void> {
  const current = currentDispatchAttempt(group),
    active = dispatchGroupIsActive(group);
  await putPgProjectionValue(client, scope, GROUP, group.attemptGroupId, "", revision, group);
  await putPgProjectionValue(client, scope, SESSION, current.runtimeSessionId, "", revision, group.attemptGroupId);
  await putPgProjectionValue(client, scope, DISPATCH, current.dispatchId, "", revision, group.attemptGroupId);
  const before = previous ? currentDispatchAttempt(previous) : null;
  if (before !== null && (before.instanceId !== current.instanceId || !active))
    await deletePgProjectionValue(client, scope, ACTIVE, group.attemptGroupId, before.instanceId);
  const beforeExecution = before?.task?.executionId ?? null,
    execution = current.task?.executionId ?? null;
  if (beforeExecution !== null && (beforeExecution !== execution || !active))
    await deletePgProjectionValue(client, scope, EXECUTION, group.attemptGroupId, beforeExecution);
  if (!active) return;
  await putPgProjectionValue(client, scope, ACTIVE, group.attemptGroupId, current.instanceId, revision, group);
  if (execution !== null)
    await putPgProjectionValue(
      client,
      scope,
      EXECUTION,
      group.attemptGroupId,
      execution,
      revision,
      group.attemptGroupId,
    );
}

async function lifecycleModelCurrent(client: PoolClient, scope: PgProjectionScope): Promise<boolean> {
  const meta = await client.query<{ dispatch_lifecycle_version: number }>(
    `SELECT dispatch_lifecycle_version FROM ha_projection_meta
     WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'`,
    [scope.tenantId, scope.projectId, scope.policyEpoch],
  );
  // No meta row yet means no events were folded: the (empty) model is current.
  return (
    (meta.rows[0]?.dispatch_lifecycle_version ?? DISPATCH_LIFECYCLE_MODEL_VERSION) === DISPATCH_LIFECYCLE_MODEL_VERSION
  );
}

/**
 * Refold the lifecycle model of a projection whose meta row names an older model version (written
 * before this model existed, or by another model version): O(canonical events) once, under the repository head lock
 * so no append interleaves; later calls are a single meta read.
 */
export async function backfillPgDispatchLifecycle(
  client: PoolClient,
  scope: PgProjectionScope,
  repoId: string,
): Promise<number> {
  const keys = [scope.tenantId, scope.projectId, repoId];
  await client.query(
    "SELECT revision FROM ha_repo_heads WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 FOR UPDATE",
    keys,
  );
  if (await lifecycleModelCurrent(client, scope)) return 0;
  await client.query(
    "DELETE FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND model = ANY($4::text[])",
    [scope.tenantId, scope.projectId, scope.policyEpoch, [...MODELS]],
  );
  const events = await client.query<{ event_json: string; readers: string[] }>(
    "SELECT event_json, readers FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 ORDER BY revision",
    keys,
  );
  let folded = 0;
  for (const row of events.rows) {
    const event = JSON.parse(row.event_json) as { readonly schema: string; readonly type: string };
    if (!isDispatchLifecycleInput(event)) continue;
    await projectPgDispatchLifecycle(client, { ...scope, readers: row.readers }, event);
    folded++;
  }
  await client.query(
    `UPDATE ha_projection_meta SET dispatch_lifecycle_version=$4
     WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'`,
    [scope.tenantId, scope.projectId, scope.policyEpoch, DISPATCH_LIFECYCLE_MODEL_VERSION],
  );
  return folded;
}

export interface PgDispatchLifecycleQueries {
  readonly readDispatchLifecycle: (query: DispatchLifecycleQuery) => Promise<DispatchLifecycleRead>;
}

export function pgDispatchLifecycleQueries(options: {
  readonly pool: Pool;
  readonly scope: PostgresScopeClaims & { readonly readers?: readonly string[] };
  readonly repoId: string;
}): PgDispatchLifecycleQueries {
  const scope = options.scope,
    readers = [...(scope.readers ?? [])];
  return {
    readDispatchLifecycle: (query) =>
      withPostgresTransaction(
        options.pool,
        async (client) => {
          const cut = await readCutInTransaction(client, scope, readers, options.repoId);
          if (cut.status !== "ready" || !(await lifecycleModelCurrent(client, scope)))
            return { status: "pending", watermark: cut.watermark, sourceRevision: cut.sourceRevision };
          const base = { status: "ready" as const, watermark: cut.watermark, sourceRevision: cut.sourceRevision };
          if (query.by !== "active") {
            const keys =
              query.by === "group"
                ? [{ groupId: query.attemptGroupId, dispatchId: undefined }]
                : await Promise.all(
                    (query.by === "dispatch" ? query.dispatchIds : [query.runtimeSessionId]).map(async (key) => ({
                      groupId: await getPgProjectionValue<string>(
                        client,
                        scope,
                        query.by === "dispatch" ? DISPATCH : SESSION,
                        key,
                      ),
                      dispatchId: query.by === "dispatch" ? key : undefined,
                    })),
                  );
            if (keys.length > DISPATCH_LIFECYCLE_PAGE_LIMIT)
              throw new Error(`dispatch lifecycle point reads accept at most ${DISPATCH_LIFECYCLE_PAGE_LIMIT} ids`);
            const rows = [];
            for (const key of keys) {
              if (key.groupId === null) continue;
              const group = await getPgProjectionValue<DispatchLifecycleGroup>(client, scope, GROUP, key.groupId);
              if (!group) continue;
              const dispatchId =
                query.by === "session"
                  ? group.attempts.find((attempt) => attempt.runtimeSessionId === query.runtimeSessionId)?.dispatchId
                  : key.dispatchId;
              rows.push(dispatchLifecycleView(group, dispatchId));
            }
            return { ...base, rows, nextCursor: null };
          }
          const limit = Math.min(Math.max(1, Math.trunc(query.limit)), DISPATCH_LIFECYCLE_PAGE_LIMIT),
            values: unknown[] = [scope.tenantId, scope.projectId, scope.policyEpoch, readers],
            predicates = [
              "tenant_id=$1",
              "project_id=$2",
              "policy_epoch=$3",
              `model='${ACTIVE}'`,
              "(cardinality($4::text[])=0 OR readers && $4::text[])",
            ];
          if (query.instanceId !== undefined) {
            values.push(query.instanceId);
            predicates.push(`owner_id=$${values.length}`);
          }
          if (query.cursor !== undefined) {
            values.push(query.cursor);
            predicates.push(`entity_id COLLATE "C">$${values.length}`);
          }
          values.push(limit + 1);
          const groups = (
              await client.query<{ value: string }>(
                `SELECT value FROM ha_projection_values WHERE ${predicates.join(" AND ")}
                 ORDER BY entity_id COLLATE "C" LIMIT $${values.length}`,
                values,
              )
            ).rows.map(({ value }) => JSON.parse(value) as DispatchLifecycleGroup),
            page = groups.slice(0, limit);
          return {
            ...base,
            rows: page.map((group) => dispatchLifecycleView(group)),
            nextCursor: groups.length > limit ? page.at(-1)!.attemptGroupId : null,
          };
        },
        scope,
        { isolationLevel: "repeatable read" },
      ),
  };
}
