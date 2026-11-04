import type { Pool } from "pg";
import { pgEpochTransactions, type PgEpochRequest } from "../postgres/pg-epoch-transaction.ts";
import type { PostgresTaskEventStoreRequest } from "../postgres/pg-task-event-store.ts";
import { WriterEpochError } from "../writer-epoch-contract.ts";

export interface PGliteOwnerGroup {
  active: boolean;
  readonly writes: Set<Promise<unknown>>;
}

/** Keep the existing authority's decisions, with a process-local gate instead of a retained
 * SQL transaction: PGlite has one session, which the append itself must be able to borrow.
 * A lost writer group drains its in-flight appends before allowing epoch retirement/acquisition.
 */
export function pgliteOwnerEpochs(pool: Pool) {
  const locks = new Map<string, OwnerGate>(),
    fences = new Map<string, PGliteOwnerGroup>(),
    gate = (repoId: string) => {
      let lock = locks.get(repoId);
      if (!lock) {
        lock = new OwnerGate(() => locks.delete(repoId));
        locks.set(repoId, lock);
      }
      return lock;
    };
  return {
    client(group: PGliteOwnerGroup, active: () => boolean) {
      const authority = pgEpochTransactions(pool);
      let retained: { readonly repoId: string; readonly release: () => void } | null = null;
      const releaseFence = () => {
        if (!retained) return;
        fences.delete(retained.repoId);
        retained.release();
        retained = null;
      };
      return {
        async execute(request: PgEpochRequest) {
          if (request.operation === "end") {
            if (!retained) throw new WriterEpochError("writer_epoch_invalid", "No embedded append fence is held");
            await Promise.allSettled([...group.writes]);
            releaseFence();
            return null;
          }
          if (
            retained ||
            (fences.get(request.repoId) === group && request.operation !== "current" && request.operation !== "floor")
          )
            throw new WriterEpochError("writer_epoch_invalid", "An embedded append fence is already held");
          assertActive(group, active);
          if (request.operation === "current" || request.operation === "floor") return authority.execute(request);
          const release = await gate(request.repoId).enter(group);
          let keep = false;
          try {
            assertActive(group, active);
            const result = await authority.execute(request);
            if (request.operation === "begin") {
              await authority.execute({ ...request, operation: "end" });
              assertActive(group, active);
              retained = { repoId: request.repoId, release };
              fences.set(request.repoId, group);
              keep = true;
            }
            return result;
          } finally {
            if (!keep) release();
          }
        },
        async close() {
          if (retained) group.active = false;
          try {
            // Request handlers observe the failures; disposal waits for their commit/rollback.
            await Promise.allSettled([...group.writes]);
            await authority.close();
          } finally {
            releaseFence();
          }
        },
      };
    },
    async canonical<Result>(
      group: PGliteOwnerGroup,
      active: () => boolean,
      request: PostgresTaskEventStoreRequest,
      operation: () => Promise<Result>,
    ): Promise<Result> {
      if (!("writerFence" in request)) return operation();
      assertActive(group, active);
      const writing = Promise.resolve().then(() => {
        assertActive(group, active);
        return operation();
      });
      group.writes.add(writing);
      try {
        return await writing;
      } finally {
        group.writes.delete(writing);
      }
    },
  };
}

function assertActive(group: PGliteOwnerGroup, active: () => boolean): void {
  if (!group.active || !active())
    throw Object.assign(new Error("Embedded storage connection closed while waiting"), {
      code: "pglite_connection_closed",
    });
}

class OwnerGate {
  private owner: object | null = null;
  private readonly waiting: { readonly group: object; readonly resolve: (release: () => void) => void }[] = [];
  private readonly onIdle: () => void;
  constructor(onIdle: () => void) {
    this.onIdle = onIdle;
  }
  async enter(group: object): Promise<() => void> {
    if (this.owner === group) return () => undefined;
    if (this.owner !== null) return new Promise((resolve) => this.waiting.push({ group, resolve }));
    this.owner = group;
    return this.releaseFor();
  }
  private releaseFor(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      this.owner = next?.group ?? null;
      if (next) next.resolve(this.releaseFor());
      else this.onIdle();
    };
  }
}
