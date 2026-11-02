// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { createPgDialectStorageBackend, createPGliteStorage, createPGliteStorageBackend } from "../../src/index.ts";
import { createPostgresPool } from "../../src/postgres/transaction.ts";

const scope = { tenantId: "runtime-tenant", projectId: "runtime-project", policyEpoch: 0 };

test("PGlite rejects unsupported Node before reading options or constructing WASM through every factory", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, "node")!;
  const options = {
    get dataDir(): string {
      throw new Error("PGlite options reached before runtime refusal");
    },
  };
  try {
    for (const version of ["24.0.0", "24.22.1", "25.9.0"]) {
      Object.defineProperty(process.versions, "node", { ...descriptor, value: version });
      const expected = {
        code: "pglite_runtime_unsupported",
        message: `PGlite requires Node.js 26 or newer; current Node.js is ${version}. SQLite and external PostgreSQL support Node.js 24.`,
      };
      assert.throws(() => createPGliteStorage(options), expected);
      assert.throws(() => createPGliteStorage(), expected);
      const storage = { backend: "pglite", scope } as const;
      await assert.rejects(createPGliteStorageBackend({ repoId: "runtime", storage }), expected);
      await assert.rejects(createPgDialectStorageBackend({ repoId: "runtime", storage }), expected);
    }
  } finally {
    Object.defineProperty(process.versions, "node", descriptor);
  }
});

test("PGlite accepts Node 26 and newer at the factory boundary", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, "node")!;
  const reached = new Error("supported runtime reached options");
  try {
    for (const version of ["26.0.0", "26.8.2", "27.0.0", "28.0.0"]) {
      Object.defineProperty(process.versions, "node", { ...descriptor, value: version });
      assert.throws(
        () =>
          createPGliteStorage({
            get dataDir(): string {
              throw reached;
            },
          }),
        (error) => error === reached,
      );
    }
  } finally {
    Object.defineProperty(process.versions, "node", descriptor);
  }
});

test("external PostgreSQL pool construction keeps its Node 24 contract", async () => {
  const pool = createPostgresPool("postgres://localhost/runtime-contract");
  assert.equal(pool.totalCount, 0);
  await pool.end();
});
