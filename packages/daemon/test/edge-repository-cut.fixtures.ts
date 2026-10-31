import { writeFileSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout, sqliteLedgerPath } from "@harness-anything/kernel";
import { startBaseBackup } from "@harness-anything/storage";
import { installReplicaGeneration, readReplicaGeneration } from "../src/fleet/replica-generation.ts";

/**
 * Materialize this repo's current ledger+projection into an offline edge replica view, the way a
 * real base backup would: startBaseBackup snapshots both databases, installReplicaGeneration
 * places the readable generation under the view root the edge config names. The caller reopens
 * the cell in remote-edge mode and answers reads from this replica without a center.
 */
export async function materializeCellReplica(rootDir: string, repoId: string, personId: string) {
  const viewRoot = path.join(rootDir, ".fleet-view"),
    viewDir = path.join(viewRoot, "repos", repoId, "views", "test-edge"),
    layout = resolveHarnessLayout(rootDir),
    transfer = await startBaseBackup({
      readerProfile: { personId, nodeId: "test-edge" },
      ledgerPath: sqliteLedgerPath(rootDir),
      projectionPath: path.join(layout.localRoot, "cache", "task.sqlite"),
      directory: path.join(rootDir, ".fleet-transfer"),
    }),
    archive = await transfer.complete,
    installed = await installReplicaGeneration({
      root: viewDir,
      archive: archive.file,
      metadata: archive.metadata,
      sha256: archive.sha256,
      size: archive.size,
      quotaBytes: 64 * 1024 * 1024,
    }),
    generation = readReplicaGeneration(viewDir)!;
  writeFileSync(
    path.join(rootDir, "fleet-edge.json"),
    JSON.stringify({
      schema: "fleet-edge-config/v1",
      repoId,
      nodeId: "test-edge",
      host: "127.0.0.1",
      port: 1,
      caPath: path.join(rootDir, "unused-ca.pem"),
      credential: "unused-offline-test",
      viewRoot,
      quotaBytes: 64 * 1024 * 1024,
    }),
  );
  return { revision: installed.metadata.position.revision, generation };
}
