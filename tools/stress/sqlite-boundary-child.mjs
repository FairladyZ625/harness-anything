// Temporary campaign probe: remove when the full chaos runner owns these cases.
import { writeSync } from "node:fs";
import { openSqliteEventStore } from "../../packages/kernel/src/store/sqlite-event-store.ts";
import { eventAt } from "../../packages/kernel/test/store/task-event-store.fixtures.ts";
import { serializePersistedCanonicalEvent } from "../../packages/kernel/src/domain/doc-sync.contract.ts";
import { sha256Text } from "../../packages/kernel/src/integrity/stable-hash.ts";

export const repoId = "stress-boundary-prototype";
export function command() {
  const events = [1, 2, 3].map(eventAt);
  return {
    fence: { repoId, holder: "successor", epoch: 2 },
    intent: {
      opId: events.at(-1).opId,
      intentDigest: `sha256:${sha256Text(JSON.stringify(events.map(serializePersistedCanonicalEvent)))}`,
      summary: "three-event probe",
    },
    events,
  };
}

if (process.argv[1] === import.meta.filename) {
  const [databasePath, boundary] = process.argv.slice(2);
  if (!["before-outcome", "after-commit", "after-receipt"].includes(boundary)) throw new Error("unknown boundary");
  const store = openSqliteEventStore({ repoId, databasePath });
  const outcome = store.appendCommand({
    ...command(),
    beforeOutcome:
      boundary === "before-outcome"
        ? () => {
            writeSync(1, `${JSON.stringify({ boundary })}\n`);
            process.kill(process.pid, "SIGKILL");
          }
        : undefined,
  });
  // appendCommand returns only after COMMIT. No close/checkpoint runs before death.
  writeSync(1, `${JSON.stringify({ boundary, ...(boundary === "after-receipt" ? { outcome } : {}) })}\n`);
  process.kill(process.pid, "SIGKILL");
}
