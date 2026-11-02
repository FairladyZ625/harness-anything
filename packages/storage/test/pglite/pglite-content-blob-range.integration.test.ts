// harness-test-tier: integration
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Bytes } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import type { PostgresTaskEventStoreRequest } from "../../src/postgres/pg-task-event-store.ts";
import type { PostgresEventStoreScope } from "../../src/postgres/pg-event-store.ts";
import { assertContentBlobRangeContract } from "../content-blob-range.contract.ts";

const scope: PostgresEventStoreScope = {
  tenantId: "tenant-content-range",
  projectId: "project-content-range",
  policyEpoch: 1,
  readers: ["reader-a"],
};

test("PGlite content blob storage fulfills the shared range-read contract", async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ha-pglite-content-range-")),
    repoId = "pglite-content-range-contract",
    body = Buffer.from("range reads stay bounded across storage backends"),
    sha256 = sha256Bytes(body),
    backend = await createPGliteStorageBackend({ repoId, storage: { backend: "pglite", dataDir, scope } });
  try {
    await backend.db.query(
      "INSERT INTO ha_content_blobs (tenant_id,project_id,sha256,size,body,readers,policy_epoch) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [scope.tenantId, scope.projectId, sha256, body.byteLength, body, scope.readers, scope.policyEpoch],
    );
    await assertContentBlobRangeContract(
      t,
      {
        readContentBlobRange: async (digest, offset, maxBytes) =>
          (await backend.eventStore.execute({
            operation: "content-range",
            sha256: digest,
            offset,
            maxBytes,
          })) as Uint8Array | null,
        readContentBlobSize: async (digest) =>
          (await backend.eventStore.execute({
            operation: "content-size",
            sha256: digest,
          } as PostgresTaskEventStoreRequest)) as number | null,
      },
      sha256,
      body,
    );
  } finally {
    await backend.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
