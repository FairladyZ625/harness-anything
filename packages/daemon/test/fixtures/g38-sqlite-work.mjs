// Test-only SQLite observation: Node exposes neither progress nor statement-work
// counters. SQLite's extension ABI observes Node's real connections, not a replica.
import sqlite from "node:sqlite";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rawSqliteStatementMethods } from "./g1-cost-probe.mjs";

const rawGet = rawSqliteStatementMethods.get,
  rawAll = rawSqliteStatementMethods.all,
  connections = new Map(),
  statements = new WeakMap();
let installed = false,
  closedSteps = 0,
  closedPages = 0;

export function sqliteWorkProbeUnavailableReason() {
  if (process.platform !== "win32") return null;
  const compiler = process.env.CC ?? "gcc",
    result = spawnSync(compiler, ["--version"], { stdio: "ignore" });
  if (result.error?.code === "ENOENT") return "G38 native SQLite observer requires a C compiler (CC or gcc)";
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`G38 compiler probe failed: ${compiler} (${result.status})`);
  return null;
}

export function installSqliteWorkProbe() {
  if (installed) return;
  const root = mkdtempSync(path.join(tmpdir(), "ha-g38-sqlite-work-")),
    suffix = process.platform === "win32" ? ".dll" : process.platform === "darwin" ? ".dylib" : ".so",
    library = path.join(root, `g38work${suffix}`),
    headers = path.join(
      path.dirname(createRequire(import.meta.url).resolve("better-sqlite3/package.json")),
      "deps/sqlite3",
    ),
    source = fileURLToPath(new URL("./g38-sqlite-work.c", import.meta.url));
  execFileSync(
    process.env.CC ?? (process.platform === "win32" ? "gcc" : "cc"),
    [
      "-O2",
      ...(process.platform === "win32" ? [] : ["-fPIC"]),
      process.platform === "darwin" ? "-dynamiclib" : "-shared",
      "-I",
      headers,
      source,
      "-o",
      library,
    ],
    { stdio: "pipe" },
  );
  if (process.platform !== "win32") process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  // The bootstrap registers sqlite3_auto_extension. Production opens retain their
  // original constructor, readonly and extension-loading settings.
  const bootstrap = new sqlite.DatabaseSync(":memory:", { allowExtension: true });
  bootstrap.loadExtension(library, "sqlite3_g38work_init");
  bootstrap.close();
  const prototype = sqlite.DatabaseSync.prototype,
    prepare = prototype.prepare,
    exec = prototype.exec,
    close = prototype.close,
    register = (db) => {
      if (!connections.has(db)) connections.set(db, prepare.call(db, "SELECT g38_read_work(?,?) AS steps"));
      return connections.get(db);
    },
    work = (db, mode, reset = 0) => rawGet.call(register(db), mode, reset).steps,
    scan = (db, operation) => {
      work(db, 2);
      try {
        return operation();
      } finally {
        work(db, 3);
      }
    },
    isCount = (statement, args) => {
      const entry = statements.get(statement);
      if (!entry) return null;
      if (entry.count === undefined) {
        // Use the engine's bytecode, not a SQL-name heuristic. An optimized Count
        // can walk every B-tree page inside one VM instruction. Exclude EXPLAIN's
        // own instructions from observation; it never executes the subject query.
        work(entry.db, 4, 1);
        try {
          const explain = prepare.call(entry.db, `EXPLAIN ${entry.sql}`);
          explain.setAllowUnknownNamedParameters(true);
          entry.count = rawAll.apply(explain, args).some((row) => row.opcode === "Count");
        } finally {
          work(entry.db, 4, 0);
        }
      }
      return entry.count ? entry.db : null;
    };
  prototype.prepare = function (sql) {
    register(this);
    const statement = prepare.call(this, sql);
    statements.set(statement, { db: this, sql });
    return statement;
  };
  // exec can contain multiple statements; charge its real page work rather than
  // classifying just the first statement. Reads normally use prepared statements.
  prototype.exec = function (...args) {
    return scan(this, () => exec.apply(this, args));
  };
  prototype.close = function () {
    if (this.isOpen) register(this);
    const steps = work(this, 0),
      pages = work(this, 1);
    close.call(this);
    closedSteps += steps;
    closedPages += pages;
    connections.delete(this);
  };
  prototype[Symbol.dispose] = function () {
    if (this.isOpen) this.close();
  };
  for (const name of ["get", "all", "run"]) {
    const original = sqlite.StatementSync.prototype[name];
    sqlite.StatementSync.prototype[name] = function (...args) {
      const db = isCount(this, args);
      return db ? scan(db, () => original.apply(this, args)) : original.apply(this, args);
    };
  }
  const iterate = sqlite.StatementSync.prototype.iterate;
  sqlite.StatementSync.prototype.iterate = function (...args) {
    const db = isCount(this, args),
      iterator = iterate.apply(this, args);
    if (db) {
      const next = iterator.next.bind(iterator);
      iterator.next = (...values) => scan(db, () => next(...values));
    }
    return iterator;
  };
  installed = true;
}

export function resetSqliteWork() {
  for (const statement of connections.values()) {
    rawGet.call(statement, 0, 1);
    rawGet.call(statement, 1, 1);
  }
  closedSteps = 0;
  closedPages = 0;
}
export function snapshotSqliteWork() {
  let sqliteVmSteps = closedSteps,
    sqliteScanPages = closedPages;
  for (const statement of connections.values()) {
    sqliteVmSteps += rawGet.call(statement, 0, 0).steps;
    sqliteScanPages += rawGet.call(statement, 1, 0).steps;
  }
  return { sqliteVmSteps, sqliteScanPages };
}
