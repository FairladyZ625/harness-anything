// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import { taskLifecycleWritePlan } from "@harness-anything/kernel/internal/domain/task-lifecycle-publication.ts";
import { makeTaskEventStore, type CanonicalWriteBundle } from "../../src/store/task-event-store.ts";
import { openSqliteMigrationEndpoint } from "../../src/migration/sqlite-endpoint.ts";
import { appendRuntimeQueryFixtures } from "../postgres/pg-runtime-query-parity.fixture.ts";
import { initRepo } from "../store/task-event-store.fixtures.ts";

for (const reason of ["lease", "runtime"] as const)
  test(`freeze refuses an unreleased ${reason} before taking the writer epoch`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-freeze-refusal-")),
      repoId = "migration",
      scope = { tenantId: "tenant", projectId: "project", policyEpoch: 0, readers: [] };
    initRepo(root);
    const store = makeTaskEventStore({ repoId, rootDir: root });
    try {
      if (reason === "lease")
        for (const event of lifecycleFixture().events.slice(0, 2))
          store.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
      else {
        const candidates: CanonicalWriteBundle[] = [];
        let revision = 1;
        await appendRuntimeQueryFixtures(
          async (value) => {
            candidates.push(value);
            revision++;
          },
          () => revision,
        );
        for (const value of candidates.slice(0, 3)) store.append(value);
      }
      const endpoint = openSqliteMigrationEndpoint({ rootDir: root, repoId, scope }),
        before = await endpoint.epoch();
      try {
        await assert.rejects(endpoint.export("refusal"), { code: `storage_migration_${reason}_active` });
        assert.equal(await endpoint.epoch(), before);
        assert.equal(await endpoint.state(), null);
        process.stdout.write(`MIGRATION_FREEZE_REFUSAL ${reason}: no epoch takeover\n`);
      } finally {
        await endpoint.close();
      }
    } finally {
      await store.drain();
      rmSync(root, { recursive: true, force: true });
    }
  });
