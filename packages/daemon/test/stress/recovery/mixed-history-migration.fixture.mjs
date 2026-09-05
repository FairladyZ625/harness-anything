import fs from "node:fs";
import { eventShapeMigrations, makeTaskEventStore, runEventShapeMigration } from "../../../../kernel/src/index.ts";

const [rootDir, repoId, migrationKind = "relation-events-migrate", killpoint = "after_event_write"] =
  process.argv.slice(2);
if (!rootDir || !repoId || !(migrationKind in eventShapeMigrations))
  throw new Error("usage: mixed-history-migration.fixture.mjs <root> <repo-id> <migration-kind> [killpoint]");

const store = makeTaskEventStore({
  repoId,
  rootDir,
  killpoint: (point) => {
    if (point !== killpoint) return;
    fs.writeSync(1, `migration-killpoint:${point}\n`);
    process.kill(process.pid, "SIGKILL");
  },
});
await runEventShapeMigration(eventShapeMigrations[migrationKind], {
  dryRun: false,
  actor: { principal: { personId: "stress-migrator" }, executor: null },
  rootDir,
  store,
  now: () => "2026-09-05T12:00:00.000Z",
});
throw new Error(`migration did not reach killpoint ${killpoint}`);
