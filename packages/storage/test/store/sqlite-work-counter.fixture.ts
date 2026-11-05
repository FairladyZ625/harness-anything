import { DatabaseSync } from "node:sqlite";
import type { TestContext } from "node:test";

/** Count native statement results and the source rows of newly built indexes, not elapsed budgets. */
export function countSqliteWork(t: TestContext, inspectIndexSources = true) {
  const prepare = DatabaseSync.prototype.prepare,
    exec = DatabaseSync.prototype.exec,
    statements: {
      phase: string;
      sql: string;
      returnedRows: number;
      indexInputRows: number;
      elapsedMs: number;
    }[] = [];
  let phase = "attach";
  let active = true;
  const measure = <T>(db: DatabaseSync, sql: string, execute: () => T): T => {
    if (!active) return execute();
    let indexInputRows = 0;
    for (const match of (inspectIndexSources ? sql : "").matchAll(
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)\s+ON\s+(\w+)/giu,
    )) {
      if (Reflect.apply(prepare, db, ["SELECT 1 FROM sqlite_master WHERE type='index' AND name=?"]).get(match[1]))
        continue;
      if (Reflect.apply(prepare, db, ["SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"]).get(match[2]))
        indexInputRows += Number(Reflect.apply(prepare, db, [`SELECT count(*) AS n FROM ${match[2]}`]).get()!.n);
    }
    // Cardinality probes above are excluded from timings/results. CREATE INDEX traverses its
    // source (including rows excluded by a partial predicate); this is not a VM-step counter.
    const started = performance.now(),
      result = execute();
    statements.push({
      phase,
      sql,
      indexInputRows,
      elapsedMs: performance.now() - started,
      returnedRows: Array.isArray(result)
        ? result.length
        : result !== undefined && /^\s*(?:SELECT|PRAGMA|WITH)/iu.test(sql)
          ? 1
          : 0,
    });
    return result;
  };
  const guards = [
    t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      const statement = Reflect.apply(prepare, this, [sql]),
        count = <T>(execute: () => T): T => measure(this, sql, execute);
      return new Proxy(statement, {
        get(target, key) {
          if (key === "iterate")
            return function* (...values: unknown[]) {
              const started = performance.now(),
                observedPhase = phase;
              let returnedRows = 0;
              try {
                for (const row of Reflect.apply(target.iterate, target, values)) {
                  returnedRows++;
                  yield row;
                }
              } finally {
                if (active)
                  statements.push({
                    phase: observedPhase,
                    sql,
                    returnedRows,
                    indexInputRows: 0,
                    elapsedMs: performance.now() - started,
                  });
              }
            };
          if (key === "get" || key === "all" || key === "run")
            return (...values: unknown[]) => count(() => Reflect.apply(target[key], target, values));
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }),
    t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      return measure(this, sql, () => Reflect.apply(exec, this, [sql]));
    }),
  ];
  return {
    phase: (value: string) => {
      phase = value;
    },
    statements,
    totals: (value: string) =>
      statements
        .filter((row) => row.phase === value)
        .reduce(
          (sum, row) => ({
            statements: sum.statements + 1,
            returnedRows: sum.returnedRows + row.returnedRows,
            indexInputRows: sum.indexInputRows + row.indexInputRows,
            elapsedMs: sum.elapsedMs + row.elapsedMs,
          }),
          { statements: 0, returnedRows: 0, indexInputRows: 0, elapsedMs: 0 },
        ),
    stop: () => {
      active = false;
      for (const guard of guards) guard.mock.restore();
    },
  };
}
