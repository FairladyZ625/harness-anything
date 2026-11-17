// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { storageForWriter } from "../src/storage-backend.ts";
import { daemonWriterEntryName } from "../src/storage-daemon-composition.ts";

// dec_04A9211B073F29F0FC1E1CA573 CH2: driver dispatch stays in storage, with no wrong-backend default.
test("each commit module is selected by storage and rejects another backend", () => {
  const sqlite = { backend: "sqlite" as const },
    postgres = { backend: "postgres" as const, connectionString: "postgres://fixture.invalid/db" },
    pglite = { backend: "pglite" as const, dataDir: "memory://fixture" };
  assert.equal(daemonWriterEntryName(), "repo-writer-worker");
  assert.equal(storageForWriter(undefined, "sqlite").backend, "sqlite");
  for (const [config, entry] of [
    [sqlite, "repo-writer-worker"],
    [postgres, "repo-writer-worker-pg"],
    [pglite, "repo-writer-worker-pglite"],
  ] as const) {
    assert.equal(daemonWriterEntryName(config), entry);
    for (const backend of ["sqlite", "postgres", "pglite"] as const) {
      if (config.backend === backend) assert.equal(storageForWriter(config, backend), config);
      else assert.throws(() => storageForWriter(config, backend), TypeError);
    }
  }
  for (const backend of ["postgres", "pglite"] as const)
    assert.throws(() => storageForWriter(undefined, backend), TypeError);
});
