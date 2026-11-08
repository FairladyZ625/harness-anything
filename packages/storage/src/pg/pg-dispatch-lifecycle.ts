// Postgres half of the dispatch lifecycle read model: the same kernel reducer, folded in the
// canonical event transaction into generic projection values. No lifecycle state is inferred in SQL.
import type { Pool, PoolClient } from "pg";
import type { AgentRuntimeEventV1 } from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import {
  DISPATCH_LIFECYCLE_PAGE_LIMIT,
  currentDispatchAttempt,
  dispatchGroupIsActive,
  dispatchLifecycleAddress,
  dispatchLifecycleView,
  reduceDispatchLifecycle,
  type DispatchLifecycleGroup,
  type DispatchLifecycleQuery,
  type DispatchLifecycleRead,
} from "@harness-anything/kernel/internal/domain/dispatch-lifecycle.ts";
import { withPostgresTransaction, type PostgresScopeClaims } from "../postgres/transaction.ts";
import { deletePgProjectionValue, getPgProjectionValue, putPgProjectionValue } from "./pg-projection-values.ts";
import { readCutInTransaction } from "./pg-event-queries.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";

const GROUP = "dispatch-lifecycle-group",
  SESSION = "dispatch-lifecycle-session",
  DISPATCH = "dispatch-lifecycle-dispatch",
  ACTIVE = "dispatch-lifecycle-active";

export async function projectPgDispatchLifecycle(
  client: PoolClient,
  scope: PgProjectionScope,
  event: AgentRuntimeEventV1,
): Promise<void> {
  const address = dispatchLifecycleAddress(event);
  if (address === null) return;
  const groupId =
      address.by === "group"
        ? address.attemptGroupId
        : await getPgProjectionValue<string>(client, scope, SESSION, address.runtimeSessionId),
    previous =
      groupId === null ? null : await getPgProjectionValue<DispatchLifecycleGroup>(client, scope, GROUP, groupId),
    step = reduceDispatchLifecycle(previous, event);
  if (step.kind !== "applied") return;
  const group = step.group,
    current = currentDispatchAttempt(group),
    revision = event.workspaceRevision;
  await putPgProjectionValue(client, scope, GROUP, group.attemptGroupId, "", revision, group);
  await putPgProjectionValue(client, scope, SESSION, current.runtimeSessionId, "", revision, group.attemptGroupId);
  await putPgProjectionValue(client, scope, DISPATCH, current.dispatchId, "", revision, group.attemptGroupId);
  const previousInstance = previous ? currentDispatchAttempt(previous).instanceId : null;
  if (previousInstance !== null && (previousInstance !== current.instanceId || !dispatchGroupIsActive(group)))
    await deletePgProjectionValue(client, scope, ACTIVE, group.attemptGroupId, previousInstance);
  if (dispatchGroupIsActive(group))
    await putPgProjectionValue(client, scope, ACTIVE, group.attemptGroupId, current.instanceId, revision, group);
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
          if (cut.status !== "ready")
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
