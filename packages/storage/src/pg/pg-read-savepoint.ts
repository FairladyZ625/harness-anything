import type { PoolClient, QueryResult } from "pg";

let nextSavepoint = 0;
/** A nested read borrows the caller's snapshot; rollback also restores its scope GUCs. */
export async function borrowPgReadClient(
  client: PoolClient,
  onRelease: () => void = () => undefined,
): Promise<PoolClient> {
  const name = `ha_read_${++nextSavepoint}`;
  await client.query(`SAVEPOINT ${name}`);
  let ending: Promise<QueryResult> | undefined,
    released = false;
  const finish = () =>
    (ending ??= client.query(`ROLLBACK TO SAVEPOINT ${name}`).then(() => client.query(`RELEASE SAVEPOINT ${name}`)));
  return {
    query: (query: string, values?: readonly unknown[]) => {
      const normalized = query.trim().replace(/;$/u, "").toUpperCase();
      if (/^BEGIN(?:\s|$)/u.test(normalized))
        return Promise.resolve({ rows: [], rowCount: null } as unknown as QueryResult);
      if (normalized === "COMMIT" || normalized === "ROLLBACK") return finish();
      return client.query(query, values as unknown[]);
    },
    on: client.on.bind(client),
    removeListener: client.removeListener.bind(client),
    release: (error?: Error | boolean) => {
      if (released) return;
      released = true;
      if (ending || error) {
        onRelease();
        return;
      }
      return finish().then(onRelease, (failure) => {
        onRelease();
        throw failure;
      });
    },
  } as unknown as PoolClient;
}
