import { writeSync } from "node:fs";
import { serializePersistedCanonicalEvent } from "../../../packages/kernel/src/domain/doc-sync.contract.ts";
import { sha256Text } from "../../../packages/kernel/src/integrity/stable-hash.ts";
import { openSqliteEventStore } from "../../../packages/kernel/src/store/sqlite-event-store.ts";
import { eventAt } from "../../../packages/kernel/test/store/task-event-store.fixtures.ts";

const [databasePath, boundary] = process.argv.slice(2);
if (!databasePath || !["before-outcome", "after-commit", "after-receipt"].includes(boundary))
  throw new Error("usage: sqlite-crash-fixture.mjs <database-path> <boundary>");

const repoId = "stress-s1-crash-fixture";
const events = [1, 2, 3].map(eventAt);
const input = {
  fence: { repoId, holder: "successor", epoch: 2 },
  intent: {
    opId: "stress-s1-crash-command",
    intentDigest: `sha256:${sha256Text(JSON.stringify(events.map(serializePersistedCanonicalEvent)))}`,
    summary: "three-event crash fixture",
  },
  events,
};
const store = openSqliteEventStore({ repoId, databasePath });
const outcome = store.appendCommand({
  ...input,
  beforeOutcome:
    boundary === "before-outcome"
      ? () => {
          writeSync(1, `${JSON.stringify({ boundary })}\n`);
          process.kill(process.pid, "SIGKILL");
        }
      : undefined,
});
writeSync(1, `${JSON.stringify({ boundary, ...(boundary === "after-receipt" ? { outcome } : {}) })}\n`);
process.kill(process.pid, "SIGKILL");
