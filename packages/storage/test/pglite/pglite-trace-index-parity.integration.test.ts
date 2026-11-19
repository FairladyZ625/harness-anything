// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { taskLifecycleWritePlan } from "@harness-anything/kernel";
import { compileFactWrite } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import { compileDecisionWrite } from "@harness-anything/kernel/internal/domain/decision-event-document.ts";
import { commitSha, lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import { makeTaskEventStore, type CanonicalWriteBundle } from "../../src/store/task-event-store.ts";
import { makeTaskProjection, makeTaskProjectionReader } from "../../src/projection/rebuildable-task-projection.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";
import { initRepo } from "../store/task-event-store.fixtures.ts";
import { withTempStoreAsync } from "../store/helpers.ts";
import { fact, proposal } from "../store/relation-graph-projection.fixtures.ts";
import { QUERY_SETTINGS_BASE } from "../postgres/pg-task-event-parity.fixture.ts";

const TRACE_PATH = "packages/storage/src/trace-target.ts",
  // Ancestor prefixes of TRACE_PATH, as the trace query sends them.
  TRACE_PREFIXES = ["packages", "packages/storage", "packages/storage/src", TRACE_PATH],
  COMMIT_B = "b".repeat(40),
  COMMIT_C = "c".repeat(40);

pgliteIntegrationSuite("reverse code-path trace index parity", () => {
  test("SQLite and PGlite answer the four trace lookups identically, through their indexes", async () => {
    await withTempStoreAsync(async (rootDir) => {
      initRepo(rootDir);
      writeFileSync(join(rootDir, "harness", "harness.yaml"), QUERY_SETTINGS_BASE);
      const repoId = "pglite-trace-parity",
        storage = {
          backend: "pglite" as const,
          dataDir: join(rootDir, "database"),
          materialize: false,
          scope: { tenantId: "trace", projectId: "trace", policyEpoch: 1 },
        },
        embedded = makeTaskEventStore({ repoId, rootDir, storage }),
        sqlite = makeTaskEventStore({ repoId, rootDir }),
        projection = makeTaskProjection({ rootDir, eventStore: sqlite });
      let revision = 1;
      const append = (candidate: CanonicalWriteBundle) => {
        embedded.append(candidate);
        sqlite.append(candidate);
        revision++;
      };
      try {
        for (const event of lifecycleFixture({ taskId: "task-trace", executionId: "execution-trace" }).events)
          append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
        for (const [factId, evidenceSource, observedCommit] of [
          ["F-0000A001", `${TRACE_PATH}:12-30`, COMMIT_B],
          // `<path>x` sorts after the `<path>:` range and is a different file: never a match.
          ["F-0000A002", `${TRACE_PATH}x`, COMMIT_C],
          ["F-0000A003", `${TRACE_PATH}#L5`, undefined],
          ["F-0000A004", TRACE_PATH, undefined],
        ] as const) {
          const draft = fact(revision);
          append(
            compileFactWrite({
              event: {
                ...draft,
                factId,
                payload: {
                  ...draft.payload,
                  evidenceSource,
                  ...(observedCommit === undefined ? {} : { observedCommit }),
                },
              },
            }),
          );
        }
        for (const [decisionId, modules] of [
          ["dec_TRACE_A", ["packages/storage/", ".\\tools\\gates", ""]],
          ["dec_TRACE_B", ["packages/storages"]],
        ] as const) {
          const draft = proposal(revision, decisionId);
          append(
            compileDecisionWrite({
              event: {
                ...draft,
                payload: { ...draft.payload, appliesTo: { modules: [...modules], productLines: [] } },
              },
              currentDecision: null,
              currentRelations: [],
              currentDocument: null,
              decisionReviewRequirement: "off",
            }),
          );
        }
        projection.catchUp();
        const reader = makeTaskProjectionReader({ repoId, storage });
        try {
          reader.withSession((queries) => {
            for (const modulePrefixes of [TRACE_PREFIXES, ["tools/gates"], ["packages/storages"], ["missing"]]) {
              const oracle = projection.listDecisions({ modulePrefixes });
              assert.deepEqual(
                queries.listDecisions({ modulePrefixes }),
                oracle,
                `modules ${modulePrefixes.join(",")}`,
              );
            }
            assert.deepEqual(
              projection.listDecisions({ modulePrefixes: TRACE_PREFIXES }).decisions.map((row) => row.decisionId),
              ["dec_TRACE_A"],
            );
            assert.deepEqual(
              projection.listDecisions({ modulePrefixes: ["tools/gates"] }).decisions.map((row) => row.decisionId),
              ["dec_TRACE_A"],
              "normalized `.\\tools\\gates` entry",
            );
            for (const filters of [
              { evidenceSourcePaths: [TRACE_PATH] },
              { evidenceSourcePaths: [TRACE_PATH], limit: 2 },
              { observedCommits: [COMMIT_B, "d".repeat(40)] },
              { observedCommits: [] as string[] },
            ]) {
              const oracle = projection.searchFacts(filters);
              assert.deepEqual(queries.searchFacts(filters), oracle, JSON.stringify(filters));
            }
            assert.deepEqual(
              projection
                .searchFacts({ evidenceSourcePaths: [TRACE_PATH] })
                .facts.map((row) => row.factId)
                .sort(),
              ["F-0000A001", "F-0000A003", "F-0000A004"],
            );
            assert.deepEqual(
              projection.searchFacts({ observedCommits: [COMMIT_B] }).facts.map((row) => row.factId),
              ["F-0000A001"],
            );
            for (const submissionCommitShas of [[commitSha], [COMMIT_B], [commitSha, COMMIT_C]]) {
              const oracle = projection.readTaskIndex({ submissionCommitShas });
              assert.deepEqual(queries.readTaskIndex({ submissionCommitShas }), oracle, submissionCommitShas.join(","));
            }
            const submitted = projection.readTaskIndex({ submissionCommitShas: [commitSha] }).rows;
            assert.deepEqual(
              submitted.map((row) => [row.taskId, row.submissionCommitShas]),
              [["task-trace", [commitSha]]],
            );
            assert.equal(projection.readTaskIndex({ submissionCommitShas: [COMMIT_B] }).rows.length, 0);
          });
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
