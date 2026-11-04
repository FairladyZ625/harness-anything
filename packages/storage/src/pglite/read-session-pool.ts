import type { Pool, PoolClient } from "pg";
import { borrowPgReadClient } from "../pg/pg-read-savepoint.ts";
import { assertPGliteGroupActive, type PGliteOwnerGroup } from "./query-owner-epochs.ts";

interface ReadFrame {
  readonly client: PoolClient;
  readonly borrowers: Set<Promise<void>>;
}

/** One controller is one synchronous worker. Its nested facades share its active read snapshot. */
export function pgliteGroupReadPool(pool: Pool, group: PGliteOwnerGroup) {
  const frames: ReadFrame[] = [];
  return {
    pool: new Proxy(pool, {
      get(target, key) {
        if (key !== "connect") {
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async () => {
          assertPGliteGroupActive(group, () => group.active);
          const frame = frames.at(-1);
          if (!frame) return target.connect();
          let resolve!: () => void;
          const released = new Promise<void>((done) => {
            resolve = done;
          });
          frame.borrowers.add(released);
          const release = () => {
            frame.borrowers.delete(released);
            resolve();
          };
          try {
            return await borrowPgReadClient(frame.client, release);
          } catch (error) {
            release();
            throw error;
          }
        };
      },
    }),
    begin(client: PoolClient) {
      frames.push({ client, borrowers: new Set() });
    },
    async beforeEnd(client: PoolClient) {
      const frame = frames.find((candidate) => candidate.client === client);
      if (frame) await Promise.all(frame.borrowers);
    },
    end(client: PoolClient) {
      const index = frames.findIndex((candidate) => candidate.client === client);
      if (index !== -1) frames.splice(index, 1);
    },
  };
}
