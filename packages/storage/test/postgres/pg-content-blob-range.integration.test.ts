// harness-test-tier: integration
import test from "node:test";
import { sha256Bytes } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS } from "../../src/postgres/event-ledger-schema.ts";
import { makePostgresTaskEventStore } from "../../src/postgres/pg-task-event-store.ts";
import { assertContentBlobRangeContract } from "../content-blob-range.assertions.ts";
import { startManagedPostgresFixture } from "./managed-postgres.fixture.ts";

test("managed PostgreSQL content blob storage fulfills the shared range-read contract", async (t) => {
  const fixture = await startManagedPostgresFixture();
  try {
    const pool = fixture.adminPool;
    for (const statement of POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS) await pool.query(statement);
    const scope = {
        tenantId: "tenant-content-range",
        projectId: "project-content-range",
        policyEpoch: 1,
        readers: ["reader-a"],
      },
      store = makePostgresTaskEventStore({ pool, repoId: "pg-content-range-contract", scope }),
      body = Buffer.from("range reads stay bounded across storage backends"),
      sha256 = sha256Bytes(body);
    await pool.query(
      "INSERT INTO ha_content_blobs (tenant_id,project_id,sha256,size,body,readers,policy_epoch) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [scope.tenantId, scope.projectId, sha256, body.byteLength, body, scope.readers, scope.policyEpoch],
    );
    await assertContentBlobRangeContract(
      t,
      {
        readContentBlobRange: async (digest, offset, maxBytes) =>
          (await store.execute({
            operation: "content-range",
            sha256: digest,
            offset,
            maxBytes,
          })) as Uint8Array | null,
        readContentBlobSize: async (digest) =>
          (await store.execute({ operation: "content-size", sha256: digest })) as number | null,
      },
      sha256,
      body,
    );
  } finally {
    await fixture.close();
  }
});
