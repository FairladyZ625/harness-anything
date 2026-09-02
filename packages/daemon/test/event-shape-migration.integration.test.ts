// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  canonicalEventWritePlan,
  deriveRelationId,
  eventObjectRelativePath,
  makeTaskEventReader,
  makeTaskEventStore,
  makeTaskProjection,
  relationEventWritePlan,
  runtimeDefinitionSnapshotArtifact,
  sha256Text,
  type AgentDefinitionSnapshot,
  type AgentRuntimeEventV1,
  type RelationEventV1,
} from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import type { RepoCellBinding } from "../src/repo-cell-types.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { actor, initRepo } from "./migration-import.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

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
    // Release the seeding store's mutable WAL ownership before the cell (and the read-only
    // cold-rebuild projection below) open their own handles onto the same `.harness/wal`.
    await store.drain();

    const coldPath = path.join(scratch, ".harness/cache/cold.sqlite"),
      cold = () =>
        makeTaskProjection({
          rootDir: scratch,
          eventStore: makeTaskEventReader({ repoId: "event-shape-fixture", rootDir: scratch }),
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
    const layout = store.layout();
    // Release the seeding store's mutable WAL ownership before the cell reopens below and
    // opens its own handle onto the same `.harness/wal`.
    await store.drain();
    const witnessOf = (opId: string) =>
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
        eventStore: makeTaskEventReader({ repoId, rootDir: scratch }),
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

test("dispatch records recover full sessions, settle tails, and release only their historical lease", async (context) => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-dispatch-records-")),
    repoId = "dispatch-records-fixture",
    binding: RepoCellBinding = { actor: { principal: actor.principal, executor: null }, source },
    records = dispatchRecordFixtures(),
    tail = records[0]!,
    full = records.slice(1),
    runtimeBinding: RepoCellBinding = {
      actor: {
        principal: actor.principal,
        executor: { kind: "agent", id: `runtime-session:${tail.runtimeSessionId}` },
      },
      source,
    };
  let cell: Awaited<ReturnType<typeof openBootstrappedRepoCell>> | undefined,
    activeStore: ReturnType<typeof makeTaskEventStore> | undefined;
  try {
    initRepo(scratch);
    cell = await openBootstrappedRepoCell({
      repoId: workspaceId(repoId),
      rootDir: canonicalRoot(scratch),
      ownerId: "dispatch-records-test",
      now: monotonicMigrationClock(),
      onStoreOpened: (opened) => {
        activeStore = opened;
      },
    });
    for (const record of records) {
      const created = (await cell.run(
        { kind: "task-create", taskId: record.taskId, title: `Dispatch fixture ${record.dispatchId}` },
        binding,
      )) as Record<string, unknown>;
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      await realizeTaskPlanFixture(scratch, String(created.packagePath), (planPath) =>
        cell!.run({ kind: "doc-submit", paths: [planPath] }, binding),
      );
      const holder = record.runtimeSessionId === tail.runtimeSessionId ? runtimeBinding : binding,
        started = await cell.run(
          { kind: "task-start", taskId: record.taskId, executionId: record.executionId },
          holder,
        );
      assert.equal(started.outcome, "applied", JSON.stringify(started));
      await addDispatchArtifacts(cell, scratch, record, holder);
      if (holder === binding) {
        const submitted = await cell.run(
          {
            kind: "task-submit",
            taskId: record.taskId,
            executionId: record.executionId,
            submission: {
              completionClaim: "Dispatch migration fixture is ready for executor attribution.",
              deliverables: [record.dispatchId],
              outputs: [record.dispatchId],
              verificationNotes: ["fixture"],
              knownGaps: [],
              residualRisks: [],
              commitSha: execFileSync("git", ["-C", scratch, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
            },
          },
          binding,
        );
        assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
      }
    }
    await cell.close();
    cell = undefined;
    await appendRuntimeMigrationBaseline(scratch, repoId, records);
    cell = await openBootstrappedRepoCell({
      repoId: workspaceId(repoId),
      rootDir: canonicalRoot(scratch),
      ownerId: "dispatch-records-test",
      now: monotonicMigrationClock(),
      onStoreOpened: (opened) => {
        activeStore = opened;
      },
    });

    const leaseConflict = await cell.run(
      { kind: "task-start", taskId: tail.taskId, executionId: tail.executionId },
      binding,
    );
    assert.equal(leaseConflict.outcome, "op_rejected", JSON.stringify(leaseConflict));
    assert.equal(leaseConflict.code, "lease_conflict");
    const noDispatchProof = await cell.run(
      {
        kind: "task-declare-executor",
        taskId: full[0]!.taskId,
        executionId: full[0]!.executionId,
        agent: `runtime-session:${full[0]!.runtimeSessionId}`,
        reason: "Negative control before dispatch recovery.",
      },
      binding,
    );
    assert.equal(noDispatchProof.outcome, "op_rejected", JSON.stringify(noDispatchProof));
    assert.equal(noDispatchProof.code, "invalid_proof");
    assert.match(String(noDispatchProof.nextAction), /no recorded runtime dispatch/u);

    const preview = (await cell.run({ kind: "dispatch-records-migrate", dryRun: true }, binding)) as Record<
      string,
      unknown
    >;
    assert.equal(preview.outcome, "pending", JSON.stringify(preview));
    const previewReport = dispatchMigrationReport(preview);
    assert.deepEqual(previewReport.categories, { "settle-tail": 1, "import-full": 2 });
    assert.deepEqual(
      previewReport.dispatches.map(({ dispatchId, action }) => [dispatchId, action]),
      [
        [tail.dispatchId, "settle-tail"],
        [full[0]!.dispatchId, "import-full"],
        [full[1]!.dispatchId, "import-full"],
      ],
    );
    assert.equal(previewReport.plannedLeaseReleases, 1);
    context.diagnostic(
      `dispatch-records dry-run sample ${JSON.stringify({
        outcome: preview.outcome,
        dispatchRecords: previewReport.dispatches.length,
        categories: previewReport.categories,
        plannedLeaseReleases: previewReport.plannedLeaseReleases,
      })}`,
    );

    const applied = (await cell.run({ kind: "dispatch-records-migrate" }, binding)) as Record<string, unknown>;
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    const appliedReport = dispatchMigrationReport(applied);
    assert.equal(appliedReport.appliedEvents, 16);
    assert.equal(appliedReport.releasedLeases, 1);
    for (const record of records) {
      const status = (await cell.read("repo.agentRuntime.sessions.read", {
          runtimeSessionId: record.runtimeSessionId,
        })) as unknown as {
          readonly session: {
            readonly liveness: string;
            readonly activity: { readonly outcome: string | null; readonly exitCode: number | null };
          };
        },
        dispatches = (await cell.read("repo.task.dispatches", { taskId: record.taskId })) as unknown as {
          readonly dispatches: readonly {
            readonly dispatchId: string;
            readonly runtimeSessionId: string;
            readonly outcome: string | null;
            readonly exitCode: number | null;
          }[];
        };
      assert.equal(status.session.liveness, "exited", record.runtimeSessionId);
      assert.equal(status.session.activity.outcome, record.outcome, record.runtimeSessionId);
      assert.equal(status.session.activity.exitCode, record.exitCode, record.runtimeSessionId);
      assert.deepEqual(
        dispatches.dispatches.map((row) => [row.dispatchId, row.runtimeSessionId, row.outcome, row.exitCode]),
        [[record.dispatchId, record.runtimeSessionId, record.outcome, record.exitCode]],
      );
    }
    assert.ok(activeStore);
    const events = activeStore.read().events,
      marker = events.find(
        (event) =>
          event.schema === "migration-import-event/v1" && event.payload.migratedFrom.startsWith("dispatch-records:"),
      ),
      tailEvents = events.filter(
        (event) =>
          event.schema === "agent-runtime-event/v1" &&
          "runtimeSessionId" in event.payload &&
          event.payload.runtimeSessionId === tail.runtimeSessionId,
      ),
      released = events.find(
        (event) => event.schema === "task-event/v1" && event.type === "lease_released" && event.taskId === tail.taskId,
      );
    assert.equal(marker?.type, "entity_migrated");
    assert.equal(marker?.schema === "migration-import-event/v1" ? marker.payload.entity.kind : null, "id-map");
    for (const record of records) {
      const runtimeEvents = events.filter(
        (event) =>
          event.schema === "agent-runtime-event/v1" &&
          "runtimeSessionId" in event.payload &&
          event.payload.runtimeSessionId === record.runtimeSessionId,
      );
      assert.equal(
        runtimeEvents
          .filter(({ type }) =>
            [
              "runtime_dispatch_requested",
              "runtime_session_started",
              "runtime_session_liveness_changed",
              "runtime_session_provider_bound",
              "runtime_session_task_bound",
            ].includes(type),
          )
          .every(({ occurredAt }) => occurredAt === record.startedAt),
        true,
        record.runtimeSessionId,
      );
      assert.equal(
        runtimeEvents
          .filter(({ type }) => type === "runtime_session_exited" || type === "runtime_session_outcome_observed")
          .every(({ occurredAt }) => occurredAt === record.endedAt),
        true,
        record.runtimeSessionId,
      );
    }
    assert.deepEqual(
      tailEvents
        .filter(({ type }) => type === "runtime_session_exited" || type === "runtime_session_outcome_observed")
        .map(({ type, occurredAt }) => [type, occurredAt]),
      [
        ["runtime_session_exited", tail.endedAt],
        ["runtime_session_outcome_observed", tail.endedAt],
      ],
    );
    assert.equal(released?.occurredAt, tail.endedAt);

    const restarted = await cell.run(
      { kind: "task-start", taskId: tail.taskId, executionId: tail.executionId },
      binding,
    );
    assert.equal(restarted.outcome, "applied", JSON.stringify(restarted));
    for (const record of full) {
      const declared = await cell.run(
        {
          kind: "task-declare-executor",
          taskId: record.taskId,
          executionId: record.executionId,
          agent: `runtime-session:${record.runtimeSessionId}`,
          reason: "Recovered canonical dispatch proof.",
        },
        binding,
      );
      assert.equal(declared.outcome, "applied", JSON.stringify(declared));
    }
    const beforeRepeat = activeStore.read().events.length,
      repeat = (await cell.run({ kind: "dispatch-records-migrate" }, binding)) as Record<string, unknown>,
      afterRepeat = activeStore.read().events.length;
    assert.equal(repeat.outcome, "pending", JSON.stringify(repeat));
    assert.deepEqual(dispatchMigrationReport(repeat).categories, { "skip:already-settled": 3 });
    assert.equal(afterRepeat, beforeRepeat);
    context.diagnostic(
      `dispatch-records idempotency sample ${JSON.stringify({
        outcome: repeat.outcome,
        categories: dispatchMigrationReport(repeat).categories,
        addedEvents: afterRepeat - beforeRepeat,
      })}`,
    );
    const rebuilt = await cell.run({ kind: "projection-rebuild" }, binding);
    assert.equal(rebuilt.outcome, "applied", JSON.stringify(rebuilt));
  } finally {
    await cell?.close?.();
    rmSync(scratch, { recursive: true, force: true });
  }
});

interface DispatchRecordFixture {
  readonly schema: "runtime-dispatch/v1";
  readonly dispatchId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly instanceId: string;
  readonly model: string;
  readonly reasoningEffort: string | null;
  readonly fast: boolean;
  readonly runtimeSessionId: string;
  readonly providerSessionId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outcome: "succeeded" | "failed";
  readonly exitCode: number;
  readonly resultRef: string;
  readonly eventStreamRef: string;
}

function dispatchRecordFixtures(): readonly DispatchRecordFixture[] {
  return [
    "dispatch_eab77a4427332feaf90333a2.json",
    "dispatch_58d3d4f10a20791ac746e2e9.json",
    "dispatch_60759907a4d1701d8bafd9a1.json",
  ].map(
    (name) =>
      JSON.parse(
        readFileSync(new URL(`./fixtures/dispatch-record-migration/${name}`, import.meta.url), "utf8"),
      ) as DispatchRecordFixture,
  );
}

async function addDispatchArtifacts(
  cell: Awaited<ReturnType<typeof openBootstrappedRepoCell>>,
  rootDir: string,
  record: DispatchRecordFixture,
  binding: RepoCellBinding,
): Promise<void> {
  const dispatchSource = `incoming-${record.dispatchId}.json`,
    reportSource = `incoming-${record.dispatchId}.md`,
    fixtureBody = readFileSync(
      new URL(`./fixtures/dispatch-record-migration/${record.dispatchId}.json`, import.meta.url),
      "utf8",
    );
  writeFileSync(path.join(rootDir, dispatchSource), fixtureBody);
  writeFileSync(path.join(rootDir, reportSource), `Recovered report for ${record.dispatchId}.\n`);
  for (const [artifactSource, destination] of [
    [dispatchSource, `dispatches/${record.dispatchId}.json`],
    [reportSource, `reports/${record.dispatchId}.md`],
  ] as const) {
    const added = await cell.run(
      { kind: "task-artifact-add", taskId: record.taskId, source: artifactSource, destination },
      binding,
    );
    assert.equal(added.outcome, "applied", `${artifactSource}: ${JSON.stringify(added)}`);
  }
}

async function appendRuntimeMigrationBaseline(
  rootDir: string,
  repoId: string,
  records: readonly DispatchRecordFixture[],
): Promise<void> {
  const store = makeTaskEventStore({ repoId, rootDir }),
    definitions = new Map(records.map((record) => [record.instanceId, definitionFor(record)] as const)),
    observed = new Set<string>();
  for (const definition of definitions.values()) {
    if (!observed.has(definition.installationId)) {
      appendRuntimeFixtureEvent(store, {
        type: "runtime_installation_observed",
        opId: `fixture-installation-${definition.installationId}`,
        occurredAt: "2026-09-02T07:00:00.000Z",
        payload: {
          installationId: definition.installationId,
          kindId: definition.kindId,
          protocolFamily: definition.kindId === "claude" ? "claude-compatible" : definition.kindId,
          hostRef: "host:local",
          version: "fixture-1.0.0",
          discoverySource: "wrapper",
          capabilities: ["structured_witness", "resume", "attach", "session_identity"],
        },
      });
      observed.add(definition.installationId);
    }
  }
  for (const [index, record] of records.slice(1).entries()) {
    const definition = definitions.get(record.instanceId)!,
      artifact = runtimeDefinitionSnapshotArtifact(definition);
    appendRuntimeFixtureEvent(
      store,
      {
        type: "runtime_dispatch_requested",
        opId: `fixture-definition-dispatch-${String(index)}`,
        occurredAt: "2026-09-02T07:01:00.000Z",
        payload: {
          dispatchId: `dispatch_${String(index + 1).repeat(24)}`,
          runtimeSessionId: `runtime_${String(index + 1).repeat(24)}`,
          instanceId: definition.instanceId,
          installationId: definition.installationId,
          kindId: definition.kindId,
          idempotencyKey: `fixture-definition-${String(index)}`,
          definitionSnapshotRef: artifact.ref,
          definitionSnapshot: definition,
        },
      },
      artifact.body,
    );
  }
  const tail = records[0]!,
    definition = definitions.get(tail.instanceId)!,
    artifact = runtimeDefinitionSnapshotArtifact(definition),
    base = migrationDispatchOpId(tail),
    common = { runtimeSessionId: tail.runtimeSessionId };
  appendRuntimeFixtureEvent(
    store,
    {
      type: "runtime_dispatch_requested",
      opId: base,
      occurredAt: tail.startedAt,
      payload: {
        dispatchId: tail.dispatchId,
        runtimeSessionId: tail.runtimeSessionId,
        instanceId: definition.instanceId,
        installationId: definition.installationId,
        kindId: definition.kindId,
        idempotencyKey: `fixture-tail-${tail.dispatchId}`,
        definitionSnapshotRef: artifact.ref,
        definitionSnapshot: definition,
      },
    },
    artifact.body,
  );
  appendRuntimeFixtureEvent(store, {
    type: "runtime_session_started",
    opId: `${base}-started`,
    occurredAt: tail.startedAt,
    payload: {
      ...common,
      instanceId: definition.instanceId,
      installationId: definition.installationId,
      kindId: definition.kindId,
      definitionSnapshotRef: artifact.ref,
      launchGeneration: 1,
      attachable: true,
    },
  });
  appendRuntimeFixtureEvent(store, {
    type: "runtime_session_liveness_changed",
    opId: `${base}-live`,
    occurredAt: tail.startedAt,
    payload: { ...common, liveness: "live" },
  });
  appendRuntimeFixtureEvent(store, {
    type: "runtime_session_provider_bound",
    opId: `${base}-provider`,
    occurredAt: tail.startedAt,
    payload: { ...common, providerSessionId: tail.providerSessionId, transcriptRef: tail.eventStreamRef },
  });
  appendRuntimeFixtureEvent(store, {
    type: "runtime_session_task_bound",
    opId: `${base}-task`,
    occurredAt: tail.startedAt,
    payload: {
      ...common,
      taskId: tail.taskId,
      executionId: tail.executionId,
      providerSessionId: tail.providerSessionId,
      transcriptRef: tail.eventStreamRef,
    },
  });
  await store.drain();
}

type RuntimeFixtureEvent = {
  [T in AgentRuntimeEventV1["type"]]: Pick<Extract<AgentRuntimeEventV1, { readonly type: T }>, "type" | "payload"> & {
    readonly opId: string;
    readonly occurredAt: string;
  };
}[AgentRuntimeEventV1["type"]];

function appendRuntimeFixtureEvent(
  store: ReturnType<typeof makeTaskEventStore>,
  fixture: RuntimeFixtureEvent,
  body?: string,
): void {
  const event = {
      schema: "agent-runtime-event/v1",
      eventId: `event-${sha256Text(fixture.opId)}`,
      workspaceRevision: (store.readHead()?.revision ?? 0) + 1,
      opId: fixture.opId,
      type: fixture.type,
      actor,
      source,
      occurredAt: fixture.occurredAt,
      payload: fixture.payload,
    } as AgentRuntimeEventV1,
    claims =
      event.type === "runtime_dispatch_requested"
        ? [runtimeDefinitionSnapshotArtifact(event.payload.definitionSnapshot).claim]
        : [];
  store.append({
    event,
    plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId),
    blobs: claims.map((claim) => ({ ...claim, body: body ?? "" })),
  });
}

function definitionFor(record: DispatchRecordFixture): AgentDefinitionSnapshot {
  const kindId = record.instanceId === "test-codex-sol" ? "codex" : record.instanceId === "glm-work" ? "agy" : "claude";
  return {
    schema: "agent-definition-snapshot/v1",
    configVersion: 1,
    instanceId: record.instanceId,
    installationId: `${kindId}-fixture-installation`,
    kindId,
    providerId: kindId === "codex" ? "openai" : kindId === "claude" ? "anthropic" : "zai",
    model: record.model,
    reasoningEffort: record.reasoningEffort,
    fast: record.fast,
    baseUrl: null,
    authMode: kindId === "agy" ? "api-key" : "subscription",
  };
}

function migrationDispatchOpId(record: DispatchRecordFixture): string {
  return `runtime-spawn-${record.dispatchId.slice(9)}${record.runtimeSessionId.slice(8, 16)}`;
}

function dispatchMigrationReport(receipt: Record<string, unknown>): {
  readonly categories: Record<string, number>;
  readonly plannedLeaseReleases: number;
  readonly appliedEvents?: number;
  readonly releasedLeases?: number;
  readonly dispatches: readonly { readonly dispatchId: string; readonly action: string }[];
} {
  return JSON.parse(String(receipt.evidence)) as ReturnType<typeof dispatchMigrationReport>;
}

function monotonicMigrationClock(): () => string {
  let tick = 0;
  const epoch = Date.parse("2026-09-03T00:00:00.000Z");
  return () => new Date(epoch + tick++ * 1_000).toISOString();
}
