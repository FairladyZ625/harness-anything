// @write-boundary-exemption rebuildable-projection
import type { Pool } from "pg";
import type { CanonicalEventV1 } from "@harness-anything/kernel";
import { normalizeHistoricalEvent } from "@harness-anything/kernel/internal/domain/historical-event-normalization.ts";
import { isEntityEvent } from "@harness-anything/kernel/internal/domain/entity-event.ts";
import { projectionCatchUpLimit } from "../projection/catch-up-limit.ts";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";
import { assertPgProjectionSchemaVersion } from "./pg-projection-schema.ts";
import { reduceAndStoreDeclaration } from "./pg-entity-declarations.ts";

export interface EntityIndexPage {
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly processed: number;
}

/** One bounded transaction under the same repo-head lock as acceptance; callers yield between pages. */
export function backfillPgEntityDeclarationPage(
  pool: Pool,
  scope: PgProjectionScope,
  repoId: string,
  maxItems = 64,
): Promise<EntityIndexPage> {
  const limit = Math.min(64, projectionCatchUpLimit(maxItems));
  return withPostgresTransaction(
    pool,
    async (client) => {
      const keys = [scope.tenantId, scope.projectId],
        head = (
          await client.query<{ revision: string }>(
            "SELECT revision FROM ha_repo_heads WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 FOR UPDATE",
            [...keys, repoId],
          )
        ).rows[0],
        meta = (
          await client.query<{ schema_version: number; watermark: string; entity_declaration_watermark: string }>(
            "SELECT schema_version,watermark,entity_declaration_watermark FROM ha_projection_meta WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'",
            [...keys, scope.policyEpoch],
          )
        ).rows[0],
        sourceRevision = Number(head?.revision ?? 0),
        watermark = Number(meta?.entity_declaration_watermark ?? 0);
      assertPgProjectionSchemaVersion(meta?.schema_version);
      if (watermark > sourceRevision)
        throw Object.assign(new Error("Declaration index is ahead of its canonical source"), {
          code: "projection_pending",
        });
      if ((!meta && sourceRevision !== 0) || (meta && Number(meta.watermark) !== sourceRevision))
        throw Object.assign(new Error("Canonical projection must be rebuilt before its declaration index"), {
          code: "projection_pending",
        });
      if (watermark === sourceRevision) return { watermark, sourceRevision, processed: 0 };
      const events = (
        await client.query<{ revision: string; event_json: string; readers: string[] }>(
          "SELECT revision,event_json,readers FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 AND revision>$4 ORDER BY revision LIMIT $5",
          [...keys, repoId, watermark, limit],
        )
      ).rows;
      let next = watermark;
      for (const row of events) {
        if (Number(row.revision) !== next + 1)
          throw Object.assign(new Error(`Declaration index cannot read canonical revision ${next + 1}`), {
            code: "projection_pending",
          });
        const event = normalizeHistoricalEvent(JSON.parse(row.event_json) as CanonicalEventV1);
        if (isEntityEvent(event)) await reduceAndStoreDeclaration(client, { ...scope, readers: row.readers }, event);
        next++;
      }
      if (next === watermark)
        throw Object.assign(
          new Error(`Declaration index is missing canonical history at ${watermark}/${sourceRevision}`),
          { code: "projection_pending" },
        );
      await client.query(
        "UPDATE ha_projection_meta SET entity_declaration_watermark=$4 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'",
        [...keys, scope.policyEpoch, next],
      );
      return { watermark: next, sourceRevision, processed: events.length };
    },
    scope,
  );
}
