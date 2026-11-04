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

/** Positive engine evidence, never inferred from the factory name or a refusal test. */
export async function reportPgVersion(pool: Pool, backend: string): Promise<void> {
  const result = await pool.query<{ version: string; server_version_num: string }>(
    "SELECT version() AS version,current_setting('server_version_num') AS server_version_num",
  );
  assert.match(result.rows[0]!.version, /^PostgreSQL/u);
  process.stdout.write(`PG_ENGINE ${backend} ${JSON.stringify({ node: process.versions.node, ...result.rows[0] })}\n`);
}
/** A separate warm invocation excludes fixture setup, downloads and EXPLAIN instrumentation. */
export async function measurePgRead<T>(backend: string, method: string, read: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await read();
  process.stdout.write(
    `PG_READ_TIME ${backend} ${JSON.stringify({ method, phase: "warm-after-explain", elapsedMs: performance.now() - started })}\n`,
  );
  return result;
}
