import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import threads from "node:worker_threads";
import { setImmediate } from "node:timers/promises";

const [mode, connectionString] = process.argv.slice(2),
  app = `reader-failure-${mode}`;
if (mode === "crash" || mode === "exit") {
  const RealWorker = threads.Worker;
  threads.Worker = class extends RealWorker {
    constructor(
      file: ConstructorParameters<typeof RealWorker>[0],
      options: ConstructorParameters<typeof RealWorker>[1],
    ) {
      super(file, {
        ...options,
        workerData: { ...options!.workerData, failureMode: mode },
        execArgv: [
          ...(options!.execArgv ?? []),
          "--import",
          new URL("./pg-reader-failure-preload.fixture.ts", import.meta.url).href,
        ],
      });
    }
  };
  syncBuiltinESMExports();
}
const { createPgTaskQueryReader } = await import("../../src/pg/pg-task-query-reader.ts"),
  url = new URL(connectionString!);
url.searchParams.set("application_name", app);
const reader = createPgTaskQueryReader({
  connectionString: url.href,
  repoId: "failure-test",
  scope: { tenantId: "failure", projectId: "failure", policyEpoch: 1 },
  queryTimeoutMs: 2000,
});
function disconnect() {
  const stdout = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { Pool } from 'pg';
    const pool=new Pool({connectionString:process.env.FAILURE_PG_URL});
    try {
      const result=await pool.query('SELECT pg_terminate_backend(pid,5000) AS terminated FROM pg_stat_activity WHERE application_name=$1',[process.env.FAILURE_PG_APP]);
      if(result.rows.length!==1 || result.rows[0].terminated!==true) throw Error('expected one reader backend');
      process.stdout.write('terminated');
    } finally {await pool.end();}
  `,
    ],
    {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, FAILURE_PG_URL: connectionString!, FAILURE_PG_APP: app },
    },
  );
  assert.equal(stdout, "terminated");
}
let failure: unknown;
try {
  if (mode === "idle") disconnect();
  reader.withSession((queries) => {
    if (mode === "session") disconnect();
    queries.readCut();
  });
} catch (error) {
  failure = error;
}
assert.ok(failure instanceof Error, "a broken worker connection must fail the reader");
assert.throws(() => reader.withSession(() => null), /closed|failed/);
reader.close();
// Let deferred Worker error/exit events run: an unhandled error would kill this child here.
await setImmediate();
await setImmediate();
process.stdout.write(
  JSON.stringify({ mode, alive: true, message: failure.message, code: Reflect.get(failure, "code") }),
);
