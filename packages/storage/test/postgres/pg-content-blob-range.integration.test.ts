// harness-test-tier: integration
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { sha256Bytes } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS } from "../../src/postgres/event-ledger-schema.ts";
import { makePostgresTaskEventStore } from "../../src/postgres/pg-task-event-store.ts";
import { assertContentBlobRangeContract } from "../content-blob-range.contract.ts";
import { startManagedPostgresFixture } from "./managed-postgres.fixture.ts";

test("managed PostgreSQL content blob storage fulfills the shared range-read contract", async (t) => {
  const fixture = await startManagedPostgresFixture();
  try {
    const schema = `content_range_${randomUUID().replaceAll("-", "")}`;
    await fixture.adminPool.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({
      host: "127.0.0.1",
      port: fixture.port,
      user: "postgres",
      database: "postgres",
      max: 1,
      options: `-c search_path=${schema},public`,
    });
    try {
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
      await pool.end();
    }
  } finally {
    await fixture.close();
  }
});
