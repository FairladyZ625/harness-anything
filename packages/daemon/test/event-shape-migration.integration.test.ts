// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  deriveRelationId,
  eventObjectRelativePath,
  makeTaskEventStore,
  makeTaskProjection,
  relationEventWritePlan,
  type RelationEventV1,
} from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { actor, initRepo } from "./migration-import.fixtures.ts";

const source = "local" as const;

function relationFacet(
  sourceRef: string,
  targetRef: string,
  type: "depends-on" | "derives" | "relates",
  targetObservedVersion: number | null,
) {
  const identity = { source: sourceRef, target: targetRef, type, direction: "directed" as const };
  return {
    relation_id: deriveRelationId(identity),
    ...identity,
    origin: "declared" as const,
    rationale: "Historical relation shape sample.",
    state: "active" as const,
    targetObservedVersion,
  };
}

function created(opId: string, workspaceRevision: number, facet: ReturnType<typeof relationFacet>): RelationEventV1 {
  return {
    schema: "relation-event/v1",
    eventId: `event-${opId}`,
    workspaceRevision,
    opId,
    relationId: facet.relation_id,
    type: "relation_created",
    actor,
    source,
    occurredAt: `2026-09-01T0${workspaceRevision}:00:00.000Z`,
    payload: { relation: facet },
  };
}

// Rewrites a committed event object into the shape relation_created events carried before
// strength derived from type: an explicit strength facet field and no target witness.
function legacyRelationBytes(rootDir: string, layout: string, event: RelationEventV1): void {
  const file = path.join(rootDir, "harness", eventObjectRelativePath(event.opId, layout as "sharded-sha256-2/v1")),
    stored = JSON.parse(readFileSync(file, "utf8")) as { payload: { relation: Record<string, unknown> } },
    { targetObservedVersion: _witness, ...facet } = stored.payload.relation;
  stored.payload.relation = { ...facet, strength: "strong" };
  writeFileSync(file, `${sortedJson(stored)}\n`);
}

// Stored event objects are canonical bytes: compact JSON with recursively sorted keys.
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : entry,
  );
}

test("relation_created history in the pre-derived-strength shape cold-rebuilds only after `migrate relation-events`", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-relation-events-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(scratch);
    const store = makeTaskEventStore({ repoId: "event-shape-fixture", rootDir: scratch }),
      first = created(
        "op-relation-first",
        1,
        relationFacet("task/task_source", "task/task_target", "depends-on", null),
      ),
      second = created(
        "op-relation-second",
        2,
        relationFacet("decision/dec_OWNER", "task/task_source", "derives", null),
      ),
      third = created("op-relation-third", 3, relationFacet("decision/dec_OWNER", "task/task_target", "relates", null));
    for (const event of [first, second, third]) store.append({ event, plan: relationEventWritePlan(event), blobs: [] });
    await store.settlePendingMaterialization?.("fixture");
    const layout = store.layout();
    legacyRelationBytes(scratch, layout, first);
    legacyRelationBytes(scratch, layout, second);
    execFileSync("git", ["-C", scratch, "commit", "-qam", "legacy relation shape"], { stdio: "ignore" });
    execFileSync("git", ["-C", scratch, "update-ref", "refs/ha/canonical", "HEAD"], { stdio: "ignore" });

    const coldPath = path.join(scratch, ".harness/cache/cold.sqlite"),
      cold = () =>
        makeTaskProjection({
          rootDir: scratch,
          eventStore: makeTaskEventStore({ repoId: "event-shape-fixture", rootDir: scratch }),
          projectionPath: coldPath,
        });
    assert.throws(() => cold().rebuild(), /Relation facet fields are invalid/u);

    cell = await openRepoCell({
      repoId: workspaceId("event-shape-fixture"),
      rootDir: canonicalRoot(scratch),
      ownerId: "event-shape-test",
      now: () => "2026-09-02T12:00:00.000Z",
    });
    const binding = { actor, source };
    const preview = (await cell.run({ kind: "relation-events-migrate", dryRun: true }, binding)) as Record<
      string,
      unknown
    >;
    assert.equal(preview.outcome, "pending", JSON.stringify(preview));
    const previewReport = JSON.parse(String(preview.evidence)) as {
      readonly rewrittenEvents: number;
      readonly categories: Record<string, number>;
      readonly samples: readonly {
        readonly before: Record<string, unknown>;
        readonly after: Record<string, unknown>;
      }[];
    };
    assert.equal(previewReport.rewrittenEvents, 2);
    assert.deepEqual(previewReport.categories, { "strength dropped, witness genesis null": 2 });
    assert.equal(previewReport.samples[0]?.before.strength, "strong");
    assert.equal(Object.hasOwn(previewReport.samples[0]?.after ?? {}, "strength"), false);
    assert.equal(previewReport.samples[0]?.after.targetObservedVersion, null);
    assert.equal(previewReport.samples[1]?.before.strength, "strong");
    assert.equal(previewReport.samples[1]?.after.targetObservedVersion, null);

    const applied = (await cell.run({ kind: "relation-events-migrate" }, binding)) as Record<string, unknown>;
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    assert.equal(applied.revision, 4);

    const rebuilt = cold().rebuild();
    assert.equal(rebuilt.watermark, 4);
    const db = new DatabaseSync(coldPath, { readOnly: true }),
      rows = db
        .prepare("SELECT relation_id, state, target_observed_version FROM relation_edge ORDER BY workspace_revision")
        .all() as readonly {
        readonly relation_id: string;
        readonly state: string;
        readonly target_observed_version: number | null;
      }[];
    db.close();
    assert.deepEqual(
      rows.map((row) => [row.relation_id, row.state, row.target_observed_version]),
      [
        [first.relationId, "active", null],
        [second.relationId, "active", null],
        [third.relationId, "active", null],
      ],
    );

    const repeat = (await cell.run({ kind: "relation-events-migrate" }, binding)) as Record<string, unknown>;
    assert.equal(repeat.outcome, "pending");
    assert.match(String(repeat.nextAction), /Nothing to migrate/u);
  } finally {
    await cell?.close?.();
    rmSync(scratch, { recursive: true, force: true });
  }
});

// Candidates separated by runs of non-candidate events: the batched replay must hand each legacy
// relation the projection state at its own revision-1, which the live write recorded as the
// target witness before the bytes were rewritten to the historical shape.
test("a migrating replay that batches non-candidates still witnesses each candidate at its own cut", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-relation-events-batched-"));
  let cell: Awaited<ReturnType<typeof openBootstrappedRepoCell>> | undefined;
  const repoId = "event-shape-batched",
    binding = { actor, source },
    open = () =>
      openBootstrappedRepoCell({
        repoId: workspaceId(repoId),
        rootDir: canonicalRoot(scratch),
        ownerId: "event-shape-test",
        now: () => "2026-09-02T12:00:00.000Z",
      }),
    run = async (action: Record<string, unknown>) => {
      const receipt = (await cell!.run(action as never, binding)) as Record<string, unknown>;
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      return receipt;
    },
    bump = async (taskId: string, times: number) => {
      for (let index = 0; index < times; index += 1)
        await run({
          kind: "task-amend",
          taskId,
          patches: [{ field: "pinned", value: index % 2 === 0 ? "true" : "false" }],
        });
    },
    relate = (sourceRef: string) =>
      run({
        kind: "relation-relate",
        sourceRef,
        targetRef: "task/task_target",
        relationType: "depends-on",
        rationale: "Batched replay witness sample.",
        expectedVersion: 0,
      });
  try {
    initRepo(scratch);
    cell = await open();
    await run({ kind: "task-create", taskId: "task_first", title: "First source" });
    await run({ kind: "task-create", taskId: "task_target", title: "Target" });
    await bump("task_target", 3);
    const first = await relate("task/task_first");
    await run({ kind: "task-create", taskId: "task_second", title: "Second source" });
    await bump("task_target", 3);
    const second = await relate("task/task_second");
    await bump("task_target", 2);
    await cell.close?.();
    cell = undefined;

    const store = makeTaskEventStore({ repoId, rootDir: scratch });
    await store.settlePendingMaterialization?.("fixture");
    const layout = store.layout(),
      witnessOf = (opId: string) =>
        (
          JSON.parse(
            readFileSync(
              path.join(scratch, "harness", eventObjectRelativePath(opId, layout as "sharded-sha256-2/v1")),
              "utf8",
            ),
          ) as { payload: { relation: { targetObservedVersion: number } } }
        ).payload.relation.targetObservedVersion,
      firstWitness = witnessOf(String(first.opId)),
      secondWitness = witnessOf(String(second.opId));
    assert.ok(
      secondWitness > firstWitness,
      `target version must advance between candidates: ${firstWitness} -> ${secondWitness}`,
    );
    for (const receipt of [first, second]) {
      const stored = JSON.parse(
        readFileSync(
          path.join(scratch, "harness", eventObjectRelativePath(String(receipt.opId), layout as "sharded-sha256-2/v1")),
          "utf8",
        ),
      ) as RelationEventV1;
      legacyRelationBytes(scratch, layout, stored);
    }
    execFileSync("git", ["-C", scratch, "commit", "-qam", "legacy relation shape"], { stdio: "ignore" });
    execFileSync("git", ["-C", scratch, "update-ref", "refs/ha/canonical", "HEAD"], { stdio: "ignore" });

    cell = await open();
    const preview = (await cell.run({ kind: "relation-events-migrate", dryRun: true }, binding)) as Record<
      string,
      unknown
    >;
    assert.equal(preview.outcome, "pending", JSON.stringify(preview));
    const report = JSON.parse(String(preview.evidence)) as {
      readonly rewrittenEvents: number;
      readonly categories: Record<string, number>;
      readonly samples: readonly {
        readonly opId: string;
        readonly workspaceRevision: number;
        readonly after: Record<string, unknown>;
      }[];
    };
    assert.equal(report.rewrittenEvents, 2);
    assert.deepEqual(report.categories, { "strength dropped, witness filled at cut": 2 });
    assert.deepEqual(
      report.samples.map((sample) => [sample.opId, sample.workspaceRevision, sample.after.targetObservedVersion]),
      [
        [first.opId, first.revision, firstWitness],
        [second.opId, second.revision, secondWitness],
      ],
    );

    const applied = (await cell.run({ kind: "relation-events-migrate" }, binding)) as Record<string, unknown>;
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    const coldPath = path.join(scratch, ".harness/cache/cold-batched.sqlite"),
      cold = makeTaskProjection({
        rootDir: scratch,
        eventStore: makeTaskEventStore({ repoId, rootDir: scratch }),
        projectionPath: coldPath,
      });
    assert.equal(cold.rebuild().watermark, applied.revision);
    cold.close();
    const db = new DatabaseSync(coldPath, { readOnly: true }),
      rows = db
        .prepare("SELECT source_ref, target_observed_version FROM relation_edge ORDER BY workspace_revision")
        .all() as readonly { readonly source_ref: string; readonly target_observed_version: number }[];
    db.close();
    assert.deepEqual(
      rows.map((row) => [row.source_ref, row.target_observed_version]),
      [
        ["task/task_first", firstWitness],
        ["task/task_second", secondWitness],
      ],
    );
  } finally {
    await cell?.close?.();
    rmSync(scratch, { recursive: true, force: true });
  }
});
