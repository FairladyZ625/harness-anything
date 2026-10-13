import { parentPort, workerData } from "node:worker_threads";
import { backup, DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { replicationContentClaims, type PersistedCanonicalEventV1 } from "@harness-anything/kernel";
import { syncFile, writeFileDurably } from "../durable-file.ts";
import type { BaseBackupArchive, BaseBackupInput, BaseBackupMetadata } from "./basebackup.ts";

const input = workerData as BaseBackupInput;
console.error("backup paths", input.ledgerPath, input.projectionPath);
const ledger = new DatabaseSync(input.ledgerPath, { readOnly: true });
const projection = new DatabaseSync(input.projectionPath, { readOnly: true });
try {
  ledger.exec("BEGIN");
  projection.exec("BEGIN");
  const state = ledger
    .prepare(
      "SELECT repo_id,generation,revision,history,sequence FROM ledger_meta JOIN replication_state USING(singleton)",
    )
    .get()!;
  const projected = projection.prepare("SELECT watermark,schema_version FROM projection_meta WHERE singleton=1").get()!;
  if (state.revision !== projected.watermark)
    throw new Error("base backup requires the projection at the accepted ledger revision");
  const metadata: BaseBackupMetadata = {
    schema: "fleet-basebackup/v2",
    repoId: String(state.repo_id),
    position: { history: String(state.history), sequence: Number(state.sequence), revision: Number(state.revision) },
    ledgerGeneration: Number(state.generation),
    projectionSchema: Number(projected.schema_version),
  };
  parentPort!.postMessage({ kind: "pinned", metadata });
  const payload = path.join(input.directory, "payload"),
    store = path.join(payload, ".harness", "store", "generations", String(metadata.ledgerGeneration)),
    cache = path.join(payload, ".harness", "cache");
  await mkdir(store, { recursive: true });
  await mkdir(cache, { recursive: true });
  await backup(ledger, path.join(store, "ledger.sqlite"));
  await backup(projection, path.join(cache, "task.sqlite"));
  const activation = `${input.ledgerPath}.activation.json`;
  if (existsSync(activation)) await copyFile(activation, path.join(store, "ledger.sqlite.activation.json"));
  const copied = new Set<string>();
  for (const row of ledger.prepare("SELECT event_json FROM event ORDER BY revision").iterate()) {
    const event = JSON.parse(String(row.event_json)) as PersistedCanonicalEventV1;
    for (const claim of replicationContentClaims(event)) {
      if (copied.has(claim.sha256)) continue;
      const relative = path.join("objects", "sha256", claim.sha256.slice(0, 2), claim.sha256.slice(2));
      const destination = path.join(store, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(path.dirname(input.ledgerPath), relative), destination);
      copied.add(claim.sha256);
    }
  }
  writeFileDurably(path.join(payload, "backup.json"), JSON.stringify(metadata));
  const file = path.join(input.directory, "base.tar.gz");
  await tar.create({ file, cwd: payload, gzip: true, portable: true, strict: true }, ["backup.json", ".harness"]);
  syncFile(file);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  const archive: BaseBackupArchive = { metadata, file, size: (await stat(file)).size, sha256: digest.digest("hex") };
  parentPort!.postMessage({ kind: "complete", archive });
} finally {
  projection.close();
  ledger.close();
}
