// harness-test-tier: integration
import assert from "node:assert/strict";
import { appendBootstrapQueryFixture } from "../postgres/query-bootstrap.fixture.ts";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { taskLifecycleWritePlan } from "@harness-anything/kernel";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import {
  canonicalEventWritePlan,
  makeTaskEventStore,
  type CanonicalWriteBundle,
} from "../../src/store/task-event-store.ts";
import { makeTaskProjection, makeTaskProjectionReader } from "../../src/projection/rebuildable-task-projection.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";
import { docBundle, initRepo } from "../store/task-event-store.fixtures.ts";
import { withTempStoreAsync } from "../store/helpers.ts";
import { appendLeaseReplayFixtures } from "../postgres/pg-lease-replay.fixture.ts";
import { appendQueryParityFixtures } from "../postgres/pg-query-parity.fixture.ts";
import { appendRuntimeQueryFixtures, assertRuntimeQueryParity } from "../postgres/pg-runtime-query-parity.fixture.ts";
import {
  appendTaskEventQueryFixtures,
  assertTaskEventQueryParity,
  QUERY_SETTINGS_BASE,
} from "../postgres/pg-task-event-parity.fixture.ts";
import { appendGraphQueryFixtures, assertCompleteQueryParity } from "../postgres/pg-complete-query-parity.fixture.ts";
import { assertTaskIndexQueryParity } from "../postgres/pg-task-index-parity.fixture.ts";
import { assertRelationQueryParity } from "../postgres/pg-relation-query-parity.fixture.ts";
import { assertValueQueryParity } from "../postgres/pg-value-query-parity.fixture.ts";
import { appendRecoveryQueryFixtures, assertRecoveryQueryContract } from "../runtime-recovery-query.assertions.ts";
import { runtimeProviderEvents } from "../runtime-provider-bytes.assertions.ts";
import {
  appendDispatchLifecycleFixtures,
  assertDispatchLifecycleParitySync,
} from "../postgres/pg-lifecycle.assertions.ts";

pgliteIntegrationSuite("complete synchronous query parity", () => {
  test("PGlite and SQLite run the same query contracts as PostgreSQL", async () => {
    await withTempStoreAsync(async (rootDir) => {
      initRepo(rootDir);
      writeFileSync(join(rootDir, "harness", "harness.yaml"), QUERY_SETTINGS_BASE);
      const repoId = "pglite-query-parity",
        storage = {
          backend: "pglite" as const,
          dataDir: join(rootDir, "database"),
          materialize: false,
          scope: { tenantId: "query", projectId: "query", policyEpoch: 1 },
        },
        embedded = makeTaskEventStore({ repoId, rootDir, storage }),
        sqlite = makeTaskEventStore({ repoId, rootDir }),
        projection = makeTaskProjection({ rootDir, eventStore: sqlite });
      let revision = 1;
      const append = async (candidate: CanonicalWriteBundle) => {
        embedded.append(candidate);
        sqlite.append(candidate);
        revision++;
      };
      try {
        for (const event of lifecycleFixture({ taskId: "task-parity", executionId: "execution-parity" }).events)
          await append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
        await appendBootstrapQueryFixture(
          append,
          () => revision,
          lifecycleFixture({ taskId: "task-parity", executionId: "execution-parity" }).events[0]!.actor,
        );
        await appendLeaseReplayFixtures(append, () => revision);
        await appendQueryParityFixtures(append, () => revision);
        await appendRuntimeQueryFixtures(append, () => revision);
        await appendTaskEventQueryFixtures(append, () => revision);
        await appendGraphQueryFixtures(append, () => revision);
        await appendRecoveryQueryFixtures(append, () => revision);
        await appendDispatchLifecycleFixtures(append, () => revision, repoId);
        // Legal provider ids may contain NUL. The fleet summary projection must read them on both
        // backends; a jsonb cast or a whole-event narrow projection would reject the event.
        let providerRevision = (embedded.readHead()?.revision ?? 0) + 1;
        for (const event of runtimeProviderEvents()) {
          const next = providerRevision++,
            adjusted = { ...event, workspaceRevision: next, eventId: `provider-${next}`, opId: `provider-op-${next}` },
            candidate = {
              event: adjusted,
              plan: canonicalEventWritePlan(adjusted, "agent-runtime/v1", `provider-op-${next}`),
              blobs: [],
            };
          embedded.append(candidate);
          sqlite.append(candidate);
          // Provider events advance the same canonical head as the helper above; keep the next
          // document bundle's expected revision in step with it.
          revision++;
        }
        // A task-package artifact gives the timeline index a document on both backends to compare.
        await append(
          docBundle(
            sqlite,
            "# Parity artifact\n",
            revision,
            "parity-artifact",
            "tasks/task-parity-fixture/artifacts/parity.md",
          ),
        );
        projection.catchUp();
        const reader = makeTaskProjectionReader({ repoId, storage });
        try {
          reader.withSession((queries) => {
            assertRuntimeQueryParity(queries, projection);
            assertTaskIndexQueryParity(queries, projection);
            assertRelationQueryParity(queries, projection);
            assertTaskEventQueryParity(queries, projection);
            assertValueQueryParity(queries, projection);
            assertCompleteQueryParity(queries, projection);
            assertRecoveryQueryContract(queries);
            for (const taskIds of [[], ["missing"], ["task-parity"], ["task-parity", "task-graph-a"]])
              assert.deepEqual(
                queries.readEventSummaries(0, 3, { taskIds }),
                projection.readEventSummaries(0, 3, { taskIds }),
              );
            assertDispatchLifecycleParitySync(queries, projection);
            const fleetSummary = queries.readEventSummaries(0, 100, "fleet");
            assert.ok(
              fleetSummary.events.some((event) => event.eventId.startsWith("provider-")),
              "PGlite fleet summary reads the accepted NUL provider event",
            );
          });
          assertRecoveryQueryContract(projection);
          assert.ok(
            projection
              .readEventSummaries(0, 100, "fleet")
              .events.some((event) => event.eventId.startsWith("provider-")),
            "SQLite fleet summary reads the accepted NUL provider event",
          );
        } finally {
          reader.close();
        }
      } finally {
        projection.close();
        await embedded.drain();
        await sqlite.drain();
      }
    });
  });
});
