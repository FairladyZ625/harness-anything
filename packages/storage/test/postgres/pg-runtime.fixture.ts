import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { startManagedPostgresFixture } from "./managed-postgres.fixture.ts";
import { POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS, POSTGRES_EVENT_LEDGER_TABLES } from "../../src/postgres/index.ts";
import { ensurePgProjectionSchema, grantPgProjectionRuntimeAccess } from "../../src/pg/index.ts";
import { POSTGRES_SCOPE_SCHEMA_CONTRACT } from "../../src/postgres/scope-schema.ts";

export async function pgRuntimeFixture() {
  const fixture = await startManagedPostgresFixture(),
    password = randomUUID().replaceAll("-", ""),
    { roles, roleAttributes } = POSTGRES_SCOPE_SCHEMA_CONTRACT;
  try {
    await fixture.adminPool.query(`CREATE ROLE "${roles.schemaOwner}" ${roleAttributes.schemaOwner}`);
    await fixture.adminPool.query(`CREATE ROLE "${roles.runtime}" ${roleAttributes.runtime} PASSWORD '${password}'`);
    await fixture.adminPool.query(`CREATE ROLE "${roles.migration}" ${roleAttributes.migration}`);
    await fixture.adminPool.query(`GRANT CREATE ON SCHEMA public TO "${roles.schemaOwner}"`);
    await fixture.adminPool.query(`SET ROLE "${roles.schemaOwner}"`);
    try {
      for (const statement of POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS) await fixture.adminPool.query(statement);
      const client = await fixture.adminPool.connect();
      try {
        await ensurePgProjectionSchema(client);
      } finally {
        client.release();
      }
    } finally {
      await fixture.adminPool.query("RESET ROLE");
    }
    const client = await fixture.adminPool.connect();
    try {
      await grantPgProjectionRuntimeAccess(client);
      for (const table of POSTGRES_EVENT_LEDGER_TABLES)
        await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO "${roles.runtime}"`);
    } finally {
      client.release();
    }
    const connectionString = `postgres://${roles.runtime}:${password}@127.0.0.1:${fixture.port}/postgres`;
    return {
      ...fixture,
      connectionString,
      managementConnectionString: `postgres://postgres@127.0.0.1:${fixture.port}/postgres`,
      pool: new Pool({ connectionString, max: 2 }),
    };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
