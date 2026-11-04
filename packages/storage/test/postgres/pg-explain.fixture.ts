import assert from "node:assert/strict";
import type { Pool } from "pg";

/** Explain the SQL issued by the real adapter, on the same connection and RLS identity. */
export function tracedPgReads(pool: Pool, plans: unknown[], predicate: (sql: string) => boolean): Pool {
  let active = 0;
  return new Proxy(pool, {
    get(target, property) {
      if (property !== "connect") {
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async () => {
        assert.equal(
          active,
          0,
          "a projection read must reuse its transaction instead of checking out a nested connection",
        );
        const client = await target.connect();
        active++;

        return new Proxy(client, {
          get(connection, key) {
            if (key === "release")
              return (...args: unknown[]) => {
                active--;
                return Reflect.apply(connection.release, connection, args);
              };
            if (key === "query")
              return async (...args: unknown[]) => {
                if (typeof args[0] === "string" && predicate(args[0])) {
                  const result = await connection.query(
                    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${args[0]}`,
                    args[1] as unknown[],
                  );
                  const plan = { sql: args[0], plan: result.rows[0]["QUERY PLAN"] };
                  plans.push(plan);
                  process.stdout.write(`QUERY_INDEX ${JSON.stringify(plan)}\n`);
                }
                return Reflect.apply(connection.query, connection, args);
              };
            const value: unknown = Reflect.get(connection, key);
            return typeof value === "function" ? value.bind(connection) : value;
          },
        });
      };
    },
  });
}
export function explainNodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(explainNodes);
  if (typeof value !== "object" || value === null) return [];
  const row = value as Record<string, unknown>;
  return [row, ...Object.values(row).flatMap(explainNodes)];
}
