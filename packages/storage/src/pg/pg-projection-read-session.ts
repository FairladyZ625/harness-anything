import type { Pool } from "pg";
import { withPostgresTransaction } from "../postgres/transaction.ts";
import { pgAggregateQueries, type PgAggregateQueries } from "./pg-aggregate-queries.ts";
import { pgCoreReadQueries, type PgCoreReadQueries } from "./pg-core-reads.ts";
import { pgReadSessionPool } from "./pg-read-savepoint.ts";
import { pgRelationPortQueries, type PgRelationPortQueries } from "./pg-relation-port-queries.ts";
import type { PgProjectionScope } from "./pg-task-event-materialize.ts";
import { pgTaskIndexQueries, type PgTaskIndexQueries } from "./pg-task-index-queries.ts";
import { pgValueQueries, type PgValueQueries } from "./pg-value-queries.ts";

export { createPostgresPool } from "../postgres/transaction.ts";

export type PgProjectionReadSession = PgCoreReadQueries &
  PgAggregateQueries &
  PgTaskIndexQueries &
  PgRelationPortQueries &
  PgValueQueries;

/** Each request owns a repeatable-read snapshot. Application query steps on it run sequentially. */
export function withPgProjectionReadSession<Result>(
  pool: Pool,
  options: {
    readonly scope: PgProjectionScope;
    readonly repoId: string;
    readonly signal: AbortSignal;
    readonly deadlineAt: number;
  },
  read: (projection: PgProjectionReadSession) => Promise<Result>,
): Promise<Result> {
  const { signal, deadlineAt, scope, repoId } = options;
  return withPostgresTransaction(
    pool,
    async (client) => {
      signal.throwIfAborted();
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        String(Math.max(1, deadlineAt - Date.now())),
      ]);
      const sourceOptions = {
        pool: pgReadSessionPool(() => {
          signal.throwIfAborted();
          return client;
        }),
        scope,
        repoId,
        ownsPool: false,
      };
      const core = pgCoreReadQueries(sourceOptions);
      const projection: PgProjectionReadSession = {
        ...core,
        ...pgAggregateQueries(sourceOptions),
        ...pgTaskIndexQueries(sourceOptions, { read: core.read, list: core.list }, () => new Date().toISOString()),
        ...pgRelationPortQueries(sourceOptions),
        ...pgValueQueries(sourceOptions),
      };
      return await read(projection);
    },
    scope,
    { isolationLevel: "repeatable read", readOnly: true },
  );
}
