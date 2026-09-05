import { serializePersistedCanonicalEvent } from "../../src/domain/doc-sync.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { openSqliteEventStore } from "../../src/store/sqlite-event-store.ts";
import { eventAt } from "./task-event-store.fixtures.ts";

const [databasePath, repoId] = process.argv.slice(2),
  store = openSqliteEventStore({ databasePath, repoId }),
  event = eventAt(1),
  eventJson = serializePersistedCanonicalEvent(event);
store.appendCommand({
  fence: { repoId, holder: "replacement-writer", epoch: 2 },
  intent: {
    opId: event.opId,
    intentDigest: `sha256:${sha256Text(eventJson)}`,
    summary: event.type,
  },
  events: [event],
  beforeOutcome: () => process.kill(process.pid, "SIGKILL"),
});
