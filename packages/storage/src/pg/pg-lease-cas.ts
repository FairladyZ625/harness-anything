import type { Pool } from "pg";
import type { LeaseV1 } from "@harness-anything/kernel";
import { canonicalJson } from "../projection/rebuildable-task-projection-sql.ts";
import {
  assertLeaseReservation,
  changedLeaseAtCut,
  effectiveLeaseValue,
} from "../projection/rebuildable-task-projection-runtime.ts";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import type { PostgresEventStoreScope } from "../postgres/pg-event-store.ts";

/** Reservations and canonical acceptance take the same scoped head lock. */
export async function changePgLease(input: {
  readonly pool: Pool;
  readonly scope: PostgresEventStoreScope;
  readonly repoId: string;
  readonly operation: "reserve" | "activate" | "renew" | "release";
  readonly expected: LeaseV1;
  readonly now: string;
  readonly expiresAt?: string;
}): Promise<LeaseV1> {
  const { pool, scope, expected, operation, now } = input;
  return withPostgresTransaction(
    pool,
    async (client) => {
      const head = await client.query(
        "SELECT repo_id FROM ha_repo_heads WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 FOR UPDATE",
        [scope.tenantId, scope.projectId, input.repoId],
      );
      if (head.rowCount !== 1) throw new Error(`lease repository ${input.repoId} is unavailable`);
      const values = [scope.tenantId, scope.projectId, scope.policyEpoch, expected.taskId],
        row = (
          await client.query<{ raw_lease: LeaseV1 | null }>(
            "SELECT raw_lease FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND task_id=$4 FOR UPDATE",
            values,
          )
        ).rows[0];
      if (!row) throw new Error(`lease task ${expected.taskId} is unavailable`);
      const current = effectiveLeaseValue(row.raw_lease, now);
      let next: LeaseV1;
      if (operation === "reserve") {
        const count = (
          await client.query<{ count: string }>(
            "SELECT COUNT(*) AS count FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND raw_lease->>'phase' NOT IN ('released','orphaned') AND raw_lease->>'expiresAt'>$4",
            [scope.tenantId, scope.projectId, scope.policyEpoch, now],
          )
        ).rows[0]!;
        assertLeaseReservation(expected, current, Number(count.count));
        next = expected;
      } else {
        const phase = operation === "release" ? "released" : "held",
          expiresAt = input.expiresAt ?? expected.expiresAt,
          accepted = changedLeaseAtCut(expected, expected, phase, expiresAt);
        // PG projects the canonical claim/renewal within append. Its following CAS observes the
        // exact event result already committed, rather than applying the transition a second time.
        if (operation !== "release" && canonicalJson(current) === canonicalJson(accepted)) return accepted;
        next = changedLeaseAtCut(current, expected, phase, expiresAt);
      }
      await client.query(
        "UPDATE ha_task_snapshots SET raw_lease=$5::jsonb WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND task_id=$4",
        [...values, JSON.stringify(next)],
      );
      return next;
    },
    scope,
  );
}
