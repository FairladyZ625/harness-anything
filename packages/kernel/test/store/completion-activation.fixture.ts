import { DatabaseSync } from "node:sqlite";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  openSqliteEventStore,
  sqliteLedgerPath,
  generationActivationCertificatePath,
} from "../../src/store/sqlite-event-store.ts";
import { createLedgerBackup } from "../../src/store/ledger-backup.ts";
import { lifecycleFixture } from "./task-lifecycle-fixture.ts";

export function completionActivationFixture(parent: string, generation: 1 | 2 = 2, empty = false) {
  const root = path.join(parent, "source"),
    backupDir = path.join(parent, "backup"),
    destinationRoot = path.join(parent, "destination");
  const authored = path.join(root, "harness");
  mkdirSync(authored, { recursive: true });
  execFileSync("git", ["init", "-q", authored]);
  execFileSync("git", ["-C", authored, "config", "user.name", "Fixture"]);
  execFileSync("git", ["-C", authored, "config", "user.email", "fixture@example.invalid"]);
  execFileSync("git", ["-C", authored, "commit", "--allow-empty", "-qm", "fixture"]);
  const events = empty ? [] : lifecycleFixture().events.slice(0, 2),
    repoId = "activation-fixture";
  const store = openSqliteEventStore({ rootInput: root, generation, repoId });
  const fence = { repoId, holder: "source", epoch: 7 };
  try {
    store.claimWriter(fence);
    store.appendCommand({
      fence,
      intent: { opId: "original", intentDigest: `sha256:${"a".repeat(64)}`, summary: "original" },
      events,
    });
    store.appendCommand({
      fence,
      intent: { opId: "rejected", intentDigest: `sha256:${"b".repeat(64)}`, summary: "rejected" },
      events: [],
      rejectionCode: "revision_conflict",
    });
  } finally {
    store.close();
  }
  // Accepted pre-cutover native executions have no gateRuns field.
  const historical = new DatabaseSync(sqliteLedgerPath(root, generation));
  for (const row of historical.prepare("SELECT revision,event_json FROM event").all()) {
    const event = JSON.parse(String(row.event_json));
    if (event.payload.execution) delete event.payload.execution.gateRuns;
    const eventJson = JSON.stringify(event) + "\n";
    historical
      .prepare("UPDATE event SET event_json=?,digest=? WHERE revision=?")
      .run(eventJson, `sha256:${sha256Text(eventJson)}`, row.revision);
  }
  historical.close();
  writeFileSync(
    generation === 1
      ? generationActivationCertificatePath(root)
      : `${sqliteLedgerPath(root, generation)}.activation.json`,
    JSON.stringify({
      schema: `generation-activation/v${generation}`,
      repoId,
      generation,
      importedPrefixRevision: 0,
      sourceDigest: `sha256:${"0".repeat(64)}`,
    }),
  );
  if (generation === 1)
    writeFileSync(
      `${sqliteLedgerPath(root, generation)}.import-source.json`,
      JSON.stringify({ sourceDigest: `sha256:${"0".repeat(64)}` }),
    );
  createLedgerBackup({ rootInput: root, generation, backupDir });
  return {
    root,
    backupDir,
    destinationRoot,
    repoId,
    events,
    approvedSnapshotGaps: new Set([`sha256:${"a".repeat(64)}`]),
  };
}
