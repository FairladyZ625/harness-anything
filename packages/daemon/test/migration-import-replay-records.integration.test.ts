// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";
import {
  REPLAY_TASK_GRAPH,
  canonicalizeContractValue,
  eventObjectRelativePath,
  makeTaskEventStore,
  readSettingsFacet,
  serializePersistedCanonicalEvent,
  sha256Text,
} from "../../kernel/src/index.ts";
import { compileRepoTaskPackage } from "../../preset/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { blob, claim, prepare } from "../src/migration-import-events.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import { realizedTaskPlan, realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

import {
  actor,
  coverageCompleteFixture,
  decisionContentFixture,
  git,
  initRepo,
  referencedDocumentFixture,
  sources,
} from "./migration-import.fixtures.ts";
test("a CAS blob referenced by any migrated repo document follows it into the event stream", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-repo-reference-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new"),
    referencedBody = "# Referenced body\n";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    referencedDocumentFixture(source, referencedBody);
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-repo-reference-target"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-06-01T00:00:00.000Z",
    });
    const result = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source) },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    const store = makeTaskEventStore({
        repoId: "migration-repo-reference-target",
        rootDir: destination,
      }),
      hash = sha256Text(referencedBody),
      event = store
        .read()
        .events.find(
          (candidate) =>
            candidate.schema === "migration-import-event/v1" &&
            candidate.payload.migratedFrom === "field-notes/reference.json",
        )!;
    assert.equal(event.payload.entity.kind, "repo-document");
    assert.deepEqual(
      (
        event.payload.entity as {
          readonly referencedContentClaims: readonly unknown[];
        }
      ).referencedContentClaims,
      [
        {
          sha256: hash,
          size: Buffer.byteLength(referencedBody),
          mediaType: "text/markdown; charset=utf-8",
        },
      ],
    );
    assert.equal(Buffer.from(store.readContentBlob(hash) ?? []).toString("utf8"), referencedBody);
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("migration replays archived executions and keeps v0 tasks explicit about contract backfill", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-covered-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    coverageCompleteFixture(source);
    writeLegacyTaskEvent(source, true);
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-covered-target"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-06-01T00:00:00.000Z",
    });
    const result = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source) },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(result.outcome, "applied");
    assert.deepEqual(result.contractRestatements, {
      task: {
        sourceV1: 1,
        targetV2: 1,
        pinnedPreserved: 1,
        pinnedExplicitFalse: 0,
        importedSnapshot: 1,
      },
    });
    assert.match(String(result.summary), /\| Task\/v1 -> Task\/v2 \| 1 \| 1 \| 1 \| 0 \| 1 imported_snapshot \|/u);
    assert.match(String(result.summary), /Authored directory audit \(informational\): complete/u);
    assert.match(String(result.summary), /\| task:executions\/\*\* \| migrated \| 1 \| PASS \|/u);
    assert.match(String(result.summary), /\| task:task_plan\.md \| migrated \| 1 \| PASS \|/u);
    assert.match(String(result.idMapPath), /^migrations\/import_[0-9a-f_]+\/id-map\.json$/u);
    const tasks = await cell.read("repo.tasks.list"),
      row = tasks.rows.find(({ taskId }) => taskId === "task_coverage")!,
      archived = row.snapshot.executions[0] as unknown as Record<string, unknown>;
    assert.equal(row.generation, "v0");
    assert.equal(row.snapshot.task?.schema, "task/v2");
    assert.equal(row.snapshot.task?.pinned, true);
    assert.equal(row.createdAt, "2026-01-01T00:00:00.000Z");
    assert.deepEqual(
      {
        schema: archived.schema,
        generation: archived.generation,
        state: archived.state,
        count: row.snapshot.executions.length,
      },
      {
        schema: "archived-execution/v1",
        generation: "v0",
        state: "accepted",
        count: 1,
      },
    );
    assert.deepEqual(
      {
        origin: row.executionEvidence[0]?.origin,
        locator: row.executionEvidence[0]?.outputs[0]?.locator,
      },
      { origin: "archival", locator: "artifacts/evidence.html" },
    );
    assert.equal(
      readFileSync(
        path.join(destination, "harness/tasks/task_coverage-coverage-fixture/executions/exe_history.md"),
        "utf8",
      ),
      readFileSync(path.join(source, "harness/tasks/task_coverage-old/executions/exe_history.md"), "utf8"),
      "the native archived execution projection must retain its exact legacy source document",
    );
    const plan = await cell.read("repo.tasks.document.read", {
      taskId: "task_coverage",
      path: "task_plan.md",
    });
    assert.equal(plan.body, realizedTaskPlan("Coverage fixture"));
    assert.equal(
      readFileSync(path.join(destination, "harness/tasks/task_coverage-coverage-fixture/task_plan.md"), "utf8"),
      plan.body,
    );
    assert.equal(
      readFileSync(
        path.join(destination, "harness/tasks/task_coverage-coverage-fixture/artifacts/evidence.html"),
        "utf8",
      ),
      "<p>historical evidence</p>\n",
    );
    assert.equal(
      readFileSync(path.join(destination, "harness/tasks/task_coverage-coverage-fixture/artifacts/INDEX.md"), "utf8"),
      "# Artifact index\n",
    );
    assert.equal(
      readFileSync(
        path.join(destination, "harness/tasks/task_coverage-coverage-fixture/artifacts/probe/executions/exe_nested.md"),
        "utf8",
      ),
      "# Nested fixture\n",
    );
    const index = await cell.read("repo.tasks.document.read", {
      taskId: "task_coverage",
      path: "INDEX.md",
    });
    assert.match(index.body, /## Lifecycle Note\n\nArchived as superseded; archivedBy=person_historical/u);
    assert.match(index.body, /## Migrated source frontmatter[\s\S]*legacyOpaque: keep-this-source-field/u);
    assert.equal(
      readFileSync(path.join(destination, "harness/tasks/task_coverage-coverage-fixture/INDEX.md"), "utf8"),
      index.body,
    );
    const migrationEvents = makeTaskEventStore({
      repoId: "migration-covered-target",
      rootDir: destination,
    })
      .read()
      .events.filter(
        (event) =>
          event.schema === "migration-import-event/v1" &&
          ["execution", "task-document"].includes(event.payload.entity.kind),
      );
    const taskMigration = makeTaskEventStore({
      repoId: "migration-covered-target",
      rootDir: destination,
    })
      .read()
      .events.find((event) => event.schema === "migration-import-event/v1" && event.payload.entity.kind === "task");
    assert.equal(taskMigration?.payload.entity.kind, "task");
    if (taskMigration?.payload.entity.kind === "task") {
      assert.equal(taskMigration.payload.entity.provenance, "imported_snapshot");
      assert.equal(taskMigration.payload.entity.task.schema, "task/v2");
      assert.equal(taskMigration.payload.entity.task.pinned, true);
    }
    assert.equal(migrationEvents.length, 5);
    assert.equal(
      migrationEvents.every((event) => event.source === "migration-import/v1" && event.payload.generation === "v0"),
      true,
    );
    const migratedContract = await cell.run(
      { kind: "task-contract-migrate", mode: "apply", taskId: "task_coverage" },
      { actor, source: "local" },
    );
    assert.equal(migratedContract.outcome, "applied", JSON.stringify(migratedContract));
    assert.match(String(migratedContract.evidence), /"status":"repair"/u);
    assert.match(String(migratedContract.evidence), /"digestSource":"compiled"/u);
    await realizeTaskPlanFixture(
      destination,
      "tasks/task_coverage-coverage-fixture",
      (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, { actor, source: "local" }),
      "Coverage fixture",
      "## Contract migration\n\nExercise the native transition after importing v0 history.",
    );
    const started = await cell.run(
      {
        kind: "task-start",
        taskId: "task_coverage",
        executionId: "exe_native_after_import",
      },
      { actor, source: "local" },
    );
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    const afterStart = (await cell.read("repo.tasks.list")).rows.find(({ taskId }) => taskId === "task_coverage")!;
    assert.deepEqual(
      afterStart.snapshot.executions.map(({ schema }) => schema),
      ["archived-execution/v1", "execution/v1"],
    );
    assert.deepEqual(
      afterStart.executionEvidence.map(({ origin }) => origin),
      ["archival", "native"],
    );
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

function writeLegacyTaskEvent(root: string, pinned: boolean): void {
  const eventsRoot = path.join(root, "harness/events/legacy");
  mkdirSync(eventsRoot, { recursive: true });
  const event = {
    schema: "task-event/v1",
    eventId: "event-legacy-task-coverage",
    workspaceRevision: 1,
    opId: "op-legacy-task-coverage",
    taskId: "task_coverage",
    type: "task_created",
    actor,
    source: "local",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: {
      task: {
        schema: "task/v1",
        taskId: "task_coverage",
        title: "Coverage fixture",
        taskClass: "standard",
        status: "planned",
        graph: REPLAY_TASK_GRAPH,
        currentNode: "implementation",
        iteration: 0,
        createdBy: actor,
        completionGateIds: [],
        presetSnapshotDigest: null,
        pinned,
      },
    },
  };
  writeFileSync(path.join(eventsRoot, "task-created.json"), `${JSON.stringify(canonicalizeContractValue(event))}\n`);
}

test("re-importing a source is an incremental no-op instead of a hard rejection", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-twice-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    coverageCompleteFixture(source);
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-twice-target"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-06-01T00:00:00.000Z",
    });
    const first = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source) },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(first.exitCode, 0, JSON.stringify(first));
    const firstRevision = first.revision;
    const second = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source) },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(second.outcome, "applied");
    assert.equal(second.exitCode, 0);
    assert.equal(second.revision, firstRevision);
    assert.match(String(second.summary), /Already imported from this Git lineage: task=1/u);
    assert.equal(cell.status().state, "attached", "a repeated import must not latch the workspace");
    const dry = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source), dryRun: true },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(dry.exitCode, 0);
    assert.match(String(dry.summary), /Already imported from this Git lineage: task=1/u);
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("re-importing after fact rekey accepts only the id-map-proven restatement", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-after-fact-rekey-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new"),
    conflict = path.join(scratch, "conflict");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    coverageCompleteFixture(source);
    writeFileSync(
      path.join(source, "harness/tasks/task_coverage-old/facts.md"),
      [
        "# Facts",
        "",
        "- {fact_id: F-ABCDEFGH, statement: Restatement remains source-bound, " +
          "source: migration-rekey-test, observedAt: 2026-01-02T00:00:00.000Z, " +
          "confidence: high, memoryClass: semantic, memoryTags: [pattern], " +
          "provenance: [{runtime: codex, sessionId: legacy-session, " +
          "boundAt: 2026-01-02T00:00:00.000Z}]}",
        "",
      ].join("\n"),
    );
    const sourceRoots = sources(source);
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-after-fact-rekey-target"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-06-01T00:00:00.000Z",
    });
    const first = (await cell.run({ kind: "migrate-import", sourceRoots }, { actor, source: "local" })) as Record<
      string,
      unknown
    >;
    assert.equal(first.exitCode, 0, JSON.stringify(first));
    const firstStore = makeTaskEventStore({ repoId: "migration-after-fact-rekey-target", rootDir: destination }),
      imported = firstStore
        .read()
        .events.find((event) => event.schema === "migration-import-event/v1" && event.payload.entity.kind === "fact");
    assert.equal(imported?.schema, "migration-import-event/v1");
    if (imported?.schema !== "migration-import-event/v1" || imported.payload.entity.kind !== "fact")
      throw new Error("fixture fact migration event is missing");
    assert.equal(imported.payload.migratedFrom, "fact/task_coverage/F-ABCDEFGH");

    const rekey = await cell.run({ kind: "fact-rekey" }, { actor, source: "local" });
    assert.equal(rekey.outcome, "applied", JSON.stringify(rekey));
    const restatedStore = makeTaskEventStore({ repoId: "migration-after-fact-rekey-target", rootDir: destination }),
      restated = restatedStore.readEvent(imported.opId);
    assert.equal(restated?.schema, "migration-import-event/v1");
    if (restated?.schema !== "migration-import-event/v1" || restated.payload.entity.kind !== "fact")
      throw new Error("fixture fact migration event was not restated");
    assert.equal(restated.payload.migratedFrom, "fact/F-ABCDEFGH");

    const dry = (await cell.run(
      { kind: "migrate-import", sourceRoots, dryRun: true },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(dry.exitCode, 0, JSON.stringify(dry));
    assert.match(String(dry.summary), /Already imported from this Git lineage: task=1, fact=1/u);
    const reconciliation = dry.reconciliation as {
      readonly fact: { readonly source: number; readonly target: number; readonly missingIds: readonly string[] };
    };
    assert.deepEqual(reconciliation.fact, {
      source: 1,
      target: 1,
      difference: 0,
      derived: 0,
      archived: 0,
      retired: 0,
      missingIds: [],
      passed: true,
    });

    await cell.close();
    cell = undefined;
    git(scratch, "clone", "-q", destination, conflict);
    git(conflict, "config", "user.name", "Migration Test");
    git(conflict, "config", "user.email", "migration@example.invalid");
    const eventPath = path.join(conflict, "harness", eventObjectRelativePath(restated.opId, restatedStore.layout())),
      tampered = {
        ...restated,
        payload: {
          ...restated.payload,
          entity: {
            ...restated.payload.entity,
            fact: { ...restated.payload.entity.fact, statement: "Different bytes under the same operation." },
          },
        },
      };
    writeFileSync(eventPath, serializePersistedCanonicalEvent(tampered));
    git(conflict, "add", path.relative(conflict, eventPath));
    git(conflict, "commit", "-qm", "mutate migration operation fixture");
    cell = await openRepoCell({
      repoId: workspaceId("migration-after-fact-rekey-conflict"),
      rootDir: canonicalRoot(conflict),
      ownerId: "migration-daemon",
      now: () => "2026-06-01T00:00:00.000Z",
    });
    const rejected = await cell.run({ kind: "migrate-import", sourceRoots, dryRun: true }, { actor, source: "local" });
    assert.match(JSON.stringify(rejected), /migration_source_operation_conflict/u);
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("migration backfills agents, schedules, and runtime sessions with a source-anchored idempotent diff", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-entity-backfill-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new"),
    fixture = entityBackfillSource(source),
    sourceRoots = sources(source);
  seedEntityBackfillProjection(source, fixture);
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-entity-backfill-target"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-08-30T00:00:00.000Z",
    });
    const store = makeTaskEventStore({ repoId: "migration-entity-backfill-target", rootDir: destination }),
      revisionBefore = store.read().revision,
      dry = (await cell.run(
        { kind: "migrate-import", sourceRoots, dryRun: true },
        { actor, source: "local" },
      )) as Record<string, unknown>;
    assert.equal(dry.exitCode, 0, JSON.stringify(dry));
    assert.equal(store.read().revision, revisionBefore, "dry-run must not mutate the destination ledger");
    assert.match(String(dry.summary), /\| agent \| backfill-agent \| create \| agents\/backfill-agent\.json \|/u);
    assert.match(String(dry.summary), /\| schedule \| backfill-schedule \| create \| event:fixture-schedule \|/u);
    assert.match(
      String(dry.summary),
      /\| runtime-session \| runtime_backfill \| create \| event:fixture-runtime-outcome \|/u,
    );

    const first = (await cell.run({ kind: "migrate-import", sourceRoots }, { actor, source: "local" })) as Record<
      string,
      unknown
    >;
    assert.equal(first.exitCode, 0, JSON.stringify(first));
    assert.match(String(first.backfillMapPath), /^migrations\/import_[0-9a-f_]+\/entity-backfill\.json$/u);
    const projection = new DatabaseSync(path.join(destination, ".harness/cache/task.sqlite"), { readOnly: true });
    try {
      const entity = projection
          .prepare(
            "SELECT entity_kind, entity_id, value_json FROM entity_projection WHERE entity_kind IN ('agent', 'schedule') ORDER BY entity_kind",
          )
          .all() as readonly {
          readonly entity_kind: string;
          readonly entity_id: string;
          readonly value_json: string;
        }[],
        runtime = projection
          .prepare("SELECT value_json FROM runtime_session WHERE runtime_session_id='runtime_backfill'")
          .get() as { readonly value_json: string };
      assert.deepEqual(
        entity.map(({ entity_kind, entity_id }) => [entity_kind, entity_id]),
        [
          ["agent", "backfill-agent"],
          ["schedule", "backfill-schedule"],
        ],
      );
      assert.deepEqual(JSON.parse(entity[0]!.value_json), fixture.agent);
      assert.deepEqual(JSON.parse(entity[1]!.value_json), fixture.schedule);
      assert.deepEqual(JSON.parse(runtime.value_json), fixture.runtimeSession);
    } finally {
      projection.close();
    }
    assert.equal(readFileSync(path.join(destination, "harness/agents/backfill-agent.json"), "utf8"), fixture.agentBody);
    assert.equal(
      readFileSync(path.join(destination, "harness/schedules/backfill-schedule.json"), "utf8"),
      fixture.scheduleBody,
    );
    const appliedStore = makeTaskEventStore({ repoId: "migration-entity-backfill-target", rootDir: destination });
    assert.equal(
      Buffer.from(appliedStore.readContentBlob(fixture.resultHash) ?? []).toString("utf8"),
      fixture.resultBody,
    );
    const firstRevision = appliedStore.read().revision,
      firstEventCount = appliedStore.read().events.length,
      second = (await cell.run({ kind: "migrate-import", sourceRoots }, { actor, source: "local" })) as Record<
        string,
        unknown
      >;
    assert.equal(second.exitCode, 0, JSON.stringify(second));
    const rerunStore = makeTaskEventStore({ repoId: "migration-entity-backfill-target", rootDir: destination });
    assert.equal(rerunStore.read().revision, firstRevision);
    assert.equal(rerunStore.read().events.length, firstEventCount);
    assert.match(String(second.summary), /agent=1, schedule=1, runtime-session=1/u);
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

function entityBackfillSource(root: string) {
  coverageCompleteFixture(root);
  const resultBody = "migration entity backfill result",
    resultHash = sha256Text(resultBody),
    agent = {
      schema: "agent-declaration/v1",
      id: "backfill-agent",
      name: "Backfill Agent",
      instructions: "Preserve the source projection and report migration evidence precisely.",
      runtime_type: "codex",
      role: "worker",
      model: "gpt-5.6-terra",
      skills: [],
    },
    schedule = {
      schema: "schedule/v1",
      scheduleId: "backfill-schedule",
      name: "Backfill schedule",
      state: "armed",
      mode: "detect",
      spec: {
        trigger: {
          kind: "interval",
          everyMs: 300_000,
          anchorAt: "2026-08-29T00:00:00.000Z",
        },
        target: {
          kind: "agent",
          agentId: "backfill-agent",
          runtimeInstanceId: "codex-default",
        },
        mission: "Inspect the migration projection without changing source history.",
      },
      createdAt: "2026-08-29T00:00:00.000Z",
      createdBy: actor,
      updatedAt: "2026-08-29T00:00:00.000Z",
      status: {
        automaticEvaluatedThrough: "2026-08-29T00:00:00.000Z",
        activeRun: null,
        lastRun: null,
        missedCount: 0,
        lastMissedAt: null,
        lastMissedReason: null,
      },
    },
    runtimeSession = {
      runtimeSessionId: "runtime_backfill",
      instanceId: "codex-default",
      installationId: "installation-codex",
      kindId: "codex",
      definitionSnapshotRef: "artifact:runtime-definition/backfill",
      providerSessionId: "provider-backfill",
      transcriptRef: "file:runtime-transcripts/backfill.jsonl",
      launchGeneration: 1,
      liveness: "exited",
      attachable: false,
      taskBindings: [
        {
          taskId: "task_coverage",
          executionId: "exe_history",
          providerSessionId: "provider-backfill",
          transcriptRef: "file:runtime-transcripts/backfill.jsonl",
          boundAt: "2026-08-29T00:00:01.000Z",
        },
      ],
      outcome: "succeeded",
      exitCode: 0,
      resultRef: `artifact:runtime-result/sha256/${resultHash}`,
      lastObservedAt: "2026-08-29T00:00:02.000Z",
    },
    agentBody = `${JSON.stringify(agent, null, 2)}\n`,
    scheduleBody = `${JSON.stringify({ ...schedule, status: undefined }, null, 2)}\n`,
    objectRoot = path.join(root, `harness/objects/sha256/${resultHash.slice(0, 2)}`);
  mkdirSync(path.join(root, "harness/agents"), { recursive: true });
  mkdirSync(path.join(root, "harness/schedules"), { recursive: true });
  mkdirSync(objectRoot, { recursive: true });
  writeFileSync(path.join(root, "harness/agents/backfill-agent.json"), agentBody);
  writeFileSync(path.join(root, "harness/schedules/backfill-schedule.json"), scheduleBody);
  writeFileSync(path.join(objectRoot, resultHash.slice(2)), resultBody);
  return { agent, schedule, runtimeSession, resultBody, resultHash, agentBody, scheduleBody } as const;
}

function seedEntityBackfillProjection(root: string, fixture: ReturnType<typeof entityBackfillSource>): void {
  const database = new DatabaseSync(path.join(root, ".harness/cache/task.sqlite"));
  try {
    const current = database.prepare("SELECT MAX(workspace_revision) AS revision FROM event_index").get() as {
        readonly revision: number;
      },
      agentRevision = current.revision + 1,
      scheduleRevision = agentRevision + 1,
      startedRevision = scheduleRevision + 1,
      outcomeRevision = startedRevision + 1,
      insertEvent = database.prepare("INSERT INTO event_index VALUES (?, ?, NULL, ?)");
    database
      .prepare("INSERT INTO entity_projection VALUES ('agent', 'backfill-agent', ?, ?)")
      .run(agentRevision, JSON.stringify(fixture.agent));
    database
      .prepare("INSERT INTO entity_projection VALUES ('schedule', 'backfill-schedule', ?, ?)")
      .run(scheduleRevision, JSON.stringify(fixture.schedule));
    database
      .prepare("INSERT INTO runtime_session VALUES ('runtime_backfill', ?, ?)")
      .run(outcomeRevision, JSON.stringify(fixture.runtimeSession));
    insertEvent.run(
      "fixture-agent",
      agentRevision,
      JSON.stringify({
        schema: "entity-event/v1",
        eventId: "fixture-agent",
        occurredAt: "2026-08-29T00:00:00.000Z",
        payload: { entityKind: "agent", entityId: "backfill-agent" },
      }),
    );
    insertEvent.run(
      "fixture-schedule",
      scheduleRevision,
      JSON.stringify({
        schema: "schedule-event/v1",
        eventId: "fixture-schedule",
        occurredAt: "2026-08-29T00:00:00.000Z",
        entity: { kind: "schedule", id: "backfill-schedule" },
        payload: {},
      }),
    );
    insertEvent.run(
      "fixture-runtime-started",
      startedRevision,
      JSON.stringify({
        schema: "agent-runtime-event/v1",
        eventId: "fixture-runtime-started",
        type: "runtime_session_started",
        occurredAt: "2026-08-29T00:00:00.000Z",
        payload: { runtimeSessionId: "runtime_backfill" },
      }),
    );
    insertEvent.run(
      "fixture-runtime-outcome",
      outcomeRevision,
      JSON.stringify({
        schema: "agent-runtime-event/v1",
        eventId: "fixture-runtime-outcome",
        type: "runtime_session_outcome_observed",
        occurredAt: fixture.runtimeSession.lastObservedAt,
        payload: {
          runtimeSessionId: "runtime_backfill",
          result: {
            sha256: fixture.resultHash,
            size: Buffer.byteLength(fixture.resultBody),
            mediaType: "text/plain; charset=utf-8",
          },
        },
      }),
    );
    database.prepare("UPDATE projection_meta SET watermark=? WHERE singleton=1").run(outcomeRevision);
  } finally {
    database.close();
  }
}

test("migration adopts the source contract digest and rewrites the contract package path", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-contract-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new"),
    digest = `sha256:${"a".repeat(64)}`;
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    coverageCompleteFixture(source);
    writeFileSync(
      path.join(source, "harness/tasks/task_coverage-old/task-contract.json"),
      `${JSON.stringify(
        {
          ...contractMetadata("task_coverage", "tasks/task_coverage-old", "Coverage fixture"),
          presetSnapshotDigest: digest,
        },
        null,
        2,
      )}\n`,
    );
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-contract-target"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-06-01T00:00:00.000Z",
    });
    const result = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source) },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    const row = (await cell.read("repo.tasks.list")).rows.find(({ taskId }) => taskId === "task_coverage")!;
    assert.equal(row.snapshot.task?.presetSnapshotDigest, digest);
    assert.equal(row.snapshot.task?.contractVersion, 1);
    const targetPackage = "tasks/task_coverage-coverage-fixture",
      contract = JSON.parse(
        readFileSync(path.join(destination, "harness", targetPackage, "task-contract.json"), "utf8"),
      ) as Record<string, unknown>;
    assert.equal(contract.taskId, "task_coverage");
    assert.equal(contract.packagePath, targetPackage);
    assert.equal(contract.presetSnapshotDigest, digest);
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("contract migration repairs old migrated rows through one canonical event and reruns as a no-op", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-migrate-contract-repair-")),
    repoId = workspaceId("migration-contract-repair"),
    taskId = "task_migrated_repair",
    packagePath = `tasks/${taskId}-repair-fixture`,
    stalePackagePath = `tasks/${taskId}-old-name`,
    missingTaskId = "task_migrated_missing_contract",
    missingPackagePath = `tasks/${missingTaskId}-missing-contract`,
    occurredAt = "2026-01-01T00:00:00.000Z";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "migration-repair-bootstrap" });
    const bootstrap = await cell.run({ kind: "projection-rebuild" }, { actor, source: "local" });
    assert.equal(bootstrap.outcome, "applied", JSON.stringify(bootstrap));
    await cell.close();
    cell = undefined;
    const settings = readSettingsFacet(readFileSync(path.join(rootDir, "harness/harness.yaml"), "utf8")),
      contractBase = contractMetadata(taskId, stalePackagePath),
      digest = compileRepoTaskPackage({
        rootDir,
        settings,
        taskId,
        action: { kind: "task-create", ...contractBase },
      }).snapshot.digest,
      missingDigest = compileRepoTaskPackage({
        rootDir,
        settings,
        taskId: missingTaskId,
        action: { kind: "task-create", ...contractMetadata(missingTaskId, missingPackagePath) },
      }).snapshot.digest,
      indexBody = `---\nschema: task-package/v2\ntask_id: ${taskId}\ntitle: Migrated repair fixture\nlifecycle:\n  status: planned\n  engine: migration-import/v1\n---\n\n# Migrated repair fixture\n`,
      contractBody = `${JSON.stringify(
        {
          ...contractBase,
          presetSnapshotDigest: digest,
          documents: [{ slot: "task.closeout", path: "closeout.md" }],
        },
        null,
        2,
      )}\n`,
      closeoutBody =
        "# Closeout\n\n## Summary\n\nPending.\n\n## Verification\n\nPending.\n\n## Residual Risk\n\nPending.\n",
      store = makeTaskEventStore({ repoId, rootDir }),
      initialRevision = store.readHead()?.revision ?? 0,
      ledger = () => makeTaskEventStore({ repoId, rootDir }).read(),
      task = {
        schema: "task/v2" as const,
        taskId,
        title: "Migrated repair fixture",
        taskClass: "standard" as const,
        status: "planned" as const,
        graph: REPLAY_TASK_GRAPH,
        currentNode: "implementation",
        iteration: 0,
        pinned: false,
        packageDisposition: "active" as const,
        createdBy: actor,
        completionGateIds: [],
        presetSnapshotDigest: null,
      };
    store.append(
      prepare(
        "legacy-source",
        actor,
        "task",
        taskId,
        occurredAt,
        initialRevision + 1,
        {
          kind: "task",
          provenance: "imported_snapshot",
          task,
          originalStatus: "planned",
          packagePath,
          documentClaim: claim(`${packagePath}/INDEX.md`, indexBody, "text/markdown"),
        },
        [blob(indexBody, "text/markdown")],
      ),
    );
    for (const [revision, name, body, mediaType] of [
      [initialRevision + 2, "task-contract.json", contractBody, "application/json"],
      [initialRevision + 3, "closeout.md", closeoutBody, "text/markdown"],
    ] as const)
      store.append(
        prepare(
          "legacy-source",
          actor,
          "task-document",
          `harness/tasks/${taskId}-old-name/${name}`,
          occurredAt,
          revision,
          {
            kind: "task-document",
            taskId,
            documentClaim: claim(`${packagePath}/${name}`, body, mediaType),
          },
          [blob(body, mediaType)],
        ),
      );
    const missingIndexBody = `---\nschema: task-package/v2\ntask_id: ${missingTaskId}\ntitle: Migrated repair fixture\nlifecycle:\n  status: planned\n  engine: migration-import/v1\n---\n\n# Migrated repair fixture\n`,
      missingTask = {
        ...task,
        taskId: missingTaskId,
        metadata: {
          idempotencyKey: null,
          parentTaskId: null,
          workKind: "chore" as const,
          riskTier: "medium" as const,
          urgency: "medium" as const,
          verticalId: "software/coding",
          presetId: "standard-task",
          profileId: "baseline",
          moduleKey: null,
          slug: "missing-contract",
          surfaces: [],
          fromLegacyId: null,
        },
      };
    store.append(
      prepare(
        "legacy-source",
        actor,
        "task",
        missingTaskId,
        occurredAt,
        initialRevision + 4,
        {
          kind: "task",
          provenance: "imported_snapshot",
          task: missingTask,
          originalStatus: "planned",
          packagePath: missingPackagePath,
          documentClaim: claim(`${missingPackagePath}/INDEX.md`, missingIndexBody, "text/markdown"),
        },
        [blob(missingIndexBody, "text/markdown")],
      ),
    );
    store.append(
      prepare(
        "legacy-source",
        actor,
        "task-document",
        `harness/tasks/${missingTaskId}-old-name/closeout.md`,
        occurredAt,
        initialRevision + 5,
        {
          kind: "task-document",
          taskId: missingTaskId,
          documentClaim: claim(`${missingPackagePath}/closeout.md`, closeoutBody, "text/markdown"),
        },
        [blob(closeoutBody, "text/markdown")],
      ),
    );
    await store.drain();
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "migration-repair-daemon" });
    const binding = { actor, source: "local" as const },
      blocked = await cell.run({ kind: "task-complete", taskId, executionId: "execution-missing" }, binding);
    assert.equal(blocked.code, "content_not_ready");
    const revisionBeforeDryRun = ledger().revision,
      dryRun = await cell.run({ kind: "task-contract-migrate", mode: "dry-run", taskId }, binding),
      dryEvidence = JSON.parse(String(dryRun.evidence)) as {
        readonly report: readonly Record<string, unknown>[];
      };
    assert.equal(dryRun.outcome, "pending");
    assert.equal(ledger().revision, revisionBeforeDryRun);
    assert.deepEqual(dryEvidence.report[0], {
      taskId,
      status: "repair",
      presetSnapshotDigestBefore: null,
      presetSnapshotDigestAfter: digest,
      packagePathBefore: stalePackagePath,
      packagePathAfter: packagePath,
      digestSource: "contract",
    });
    const applied = await cell.run({ kind: "task-contract-migrate", mode: "apply", taskId }, binding);
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    assert.equal(ledger().revision, revisionBeforeDryRun + 1);
    assert.equal(ledger().events.filter((event) => event.type === "task_contract_migrated").length, 1);
    const repaired = (await cell.read("repo.tasks.list")).rows.find((row) => row.taskId === taskId)!;
    assert.equal(repaired.snapshot.task?.presetSnapshotDigest, digest);
    assert.equal(repaired.snapshot.task?.contractVersion, 1);
    const repairedContract = JSON.parse(
      readFileSync(path.join(rootDir, "harness", packagePath, "task-contract.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(repairedContract.packagePath, packagePath);
    assert.equal(repairedContract.presetSnapshotDigest, digest);
    const nextGate = await cell.run({ kind: "task-complete", taskId, executionId: "execution-missing" }, binding);
    assert.notEqual(nextGate.code, "content_not_ready", JSON.stringify(nextGate));
    assert.equal(nextGate.code, "not_in_review", JSON.stringify(nextGate));
    const revisionBeforeRerun = ledger().revision,
      rerun = await cell.run({ kind: "task-contract-migrate", mode: "apply", taskId }, binding);
    assert.equal(rerun.outcome, "applied", JSON.stringify(rerun));
    assert.equal(ledger().revision, revisionBeforeRerun);
    assert.equal(ledger().events.filter((event) => event.type === "task_contract_migrated").length, 1);
    const missingDryRun = await cell.run(
        { kind: "task-contract-migrate", mode: "dry-run", taskId: missingTaskId },
        binding,
      ),
      missingEvidence = JSON.parse(String(missingDryRun.evidence)) as {
        readonly report: readonly Record<string, unknown>[];
      };
    assert.deepEqual(missingEvidence.report[0], {
      taskId: missingTaskId,
      status: "repair",
      presetSnapshotDigestBefore: null,
      presetSnapshotDigestAfter: missingDigest,
      packagePathBefore: null,
      packagePathAfter: missingPackagePath,
      digestSource: "compiled",
    });
    assert.equal(
      (await cell.run({ kind: "task-contract-migrate", mode: "apply", taskId: missingTaskId }, binding)).outcome,
      "applied",
    );
    const synthesizedContract = JSON.parse(
      readFileSync(path.join(rootDir, "harness", missingPackagePath, "task-contract.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(synthesizedContract.packagePath, missingPackagePath);
    assert.equal(synthesizedContract.presetSnapshotDigest, missingDigest);
    assert.equal(Array.isArray(synthesizedContract.documents), true);
    const missingNextGate = await cell.run(
      { kind: "task-complete", taskId: missingTaskId, executionId: "execution-missing" },
      binding,
    );
    assert.equal(missingNextGate.code, "not_in_review", JSON.stringify(missingNextGate));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("contract migration deterministically disposes all three canonical manual families and stays idempotent", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-migrate-contract-manual-families-")),
    repoId = workspaceId("migration-contract-manual-families"),
    occurredAt = "2026-08-31T00:00:00.000Z",
    samples = [
      {
        taskId: "task_01KWFQ0285MRXE92BYX7AGF9HD",
        title: "M3 triadic kernel milestone main coordination task",
        slug: "m3-triadic-kernel",
        sourcePresetId: "long-running-task",
        targetPresetId: "standard-task",
        targetTaskClass: "standard" as const,
        disposition: "retired-preset-to-standard-task",
        hasSourceContract: false,
      },
      {
        taskId: "task_01KX51Z7HJTS56CTSVCTEM1SRF",
        title: "进展页持续维护（library.qianbaner.top）",
        slug: "library-qianbaner-top",
        sourcePresetId: "progress-site",
        targetPresetId: "standard-task",
        targetTaskClass: "standard" as const,
        disposition: "retired-preset-to-standard-task",
        hasSourceContract: true,
      },
      {
        taskId: "task_01KXAWVMTP3GV0QD7E5570CE4B",
        title: "PLT-Attribution:双轴归属主干统一切面(ADR-0028)",
        slug: "plt-attribution-adr-0028",
        sourcePresetId: "create-milestone",
        targetPresetId: "create-milestone",
        targetTaskClass: "milestone" as const,
        disposition: "preset-task-class-aligned",
        hasSourceContract: false,
      },
    ];
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "manual-family-bootstrap" });
    assert.equal((await cell.run({ kind: "projection-rebuild" }, { actor, source: "local" })).outcome, "applied");
    await cell.close();
    cell = undefined;
    const settings = readSettingsFacet(readFileSync(path.join(rootDir, "harness/harness.yaml"), "utf8")),
      store = makeTaskEventStore({ repoId, rootDir });
    let revision = store.readHead()?.revision ?? 0;
    for (const sample of samples) {
      const target = compileRepoTaskPackage({
          rootDir,
          settings,
          taskId: sample.taskId,
          action: {
            kind: "task-create",
            title: sample.title,
            slug: sample.slug,
            presetId: sample.targetPresetId,
            taskClass: sample.targetTaskClass,
            verticalId: "software/coding",
            profileId: "baseline",
          },
        }),
        packagePath = target.packagePath,
        index = target.documents.find(({ slot }) => slot === "task.index")!,
        task = {
          schema: "task/v2" as const,
          taskId: sample.taskId,
          title: sample.title,
          taskClass: "standard" as const,
          status: "planned" as const,
          graph: REPLAY_TASK_GRAPH,
          currentNode: "implementation",
          iteration: 0,
          pinned: false,
          packageDisposition: "active" as const,
          createdBy: actor,
          completionGateIds: [],
          presetSnapshotDigest: null,
          metadata: {
            idempotencyKey: null,
            parentTaskId: null,
            workKind: "chore" as const,
            riskTier: "medium" as const,
            urgency: "medium" as const,
            verticalId: "software/coding",
            presetId: sample.sourcePresetId,
            profileId: "baseline",
            moduleKey: null,
            slug: sample.slug,
            surfaces: [],
            fromLegacyId: null,
          },
        };
      store.append(
        prepare(
          "legacy-source",
          actor,
          "task",
          sample.taskId,
          occurredAt,
          ++revision,
          {
            kind: "task",
            provenance: "imported_snapshot",
            task,
            originalStatus: "planned",
            packagePath,
            documentClaim: claim(index.path, index.body, index.mediaType),
          },
          [blob(index.body, index.mediaType)],
        ),
      );
      for (const document of target.documents.filter(({ slot }) => slot !== "task.index")) {
        if (document.slot === "task.contract" && !sample.hasSourceContract) continue;
        const body =
          document.slot === "task.contract"
            ? `${JSON.stringify(
                {
                  schema: "task-contract/v1",
                  contractVersion: 1,
                  taskId: sample.taskId,
                  title: sample.title,
                  taskClass: "standard",
                  metadata: task.metadata,
                },
                null,
                2,
              )}\n`
            : document.body;
        store.append(
          prepare(
            "legacy-source",
            actor,
            "task-document",
            `harness/${packagePath}/${document.relativePath}`,
            occurredAt,
            ++revision,
            {
              kind: "task-document",
              taskId: sample.taskId,
              documentClaim: claim(document.path, body, document.mediaType),
            },
            [blob(body, document.mediaType)],
          ),
        );
      }
    }
    await store.drain();
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "manual-family-daemon" });
    const binding = { actor, source: "local" as const },
      before = makeTaskEventStore({ repoId, rootDir }).read().revision,
      dry = await cell.run({ kind: "task-contract-migrate", mode: "dry-run" }, binding),
      evidence = JSON.parse(String(dry.evidence)) as {
        readonly report: readonly Record<string, unknown>[];
        readonly manual: readonly Record<string, unknown>[];
      };
    assert.equal(dry.outcome, "pending");
    assert.equal(makeTaskEventStore({ repoId, rootDir }).read().revision, before);
    assert.equal(evidence.manual.length, 0);
    for (const sample of samples) {
      const row = evidence.report.find(({ taskId }) => taskId === sample.taskId)!;
      assert.equal(row.status, "repair");
      assert.equal(row.disposition, sample.disposition);
      assert.equal(row.presetIdAfter, sample.targetPresetId);
      assert.equal(row.taskClassAfter, sample.targetTaskClass);
    }
    const applied = await cell.run({ kind: "task-contract-migrate", mode: "apply" }, binding);
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    const firstLedger = makeTaskEventStore({ repoId, rootDir }).read();
    assert.equal(firstLedger.revision, before + samples.length);
    assert.equal(firstLedger.events.filter((event) => event.type === "task_contract_migrated").length, samples.length);
    const rows = (await cell.read("repo.tasks.list")).rows;
    for (const sample of samples) {
      const repaired = rows.find(({ taskId }) => taskId === sample.taskId)!.snapshot.task!;
      assert.equal(repaired.metadata?.presetId, sample.targetPresetId);
      assert.equal(repaired.taskClass, sample.targetTaskClass);
      assert.match(String(repaired.presetSnapshotDigest), /^sha256:[0-9a-f]{64}$/u);
    }
    const rerun = await cell.run({ kind: "task-contract-migrate", mode: "apply" }, binding),
      secondLedger = makeTaskEventStore({ repoId, rootDir }).read();
    assert.equal(rerun.outcome, "applied", JSON.stringify(rerun));
    assert.equal(secondLedger.revision, firstLedger.revision);
    assert.equal(secondLedger.events.length, firstLedger.events.length);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function contractMetadata(taskId: string, packagePath: string, title = "Migrated repair fixture") {
  return {
    schema: "task-contract/v1",
    contractVersion: 1,
    taskId,
    packagePath,
    title,
    taskClass: "standard",
    verticalId: "software/coding",
    presetId: "standard-task",
    profileId: "baseline",
    locale: "en-US",
  } as const;
}

test("decision replay keeps source prose and legacy frontmatter readable beside the native projection", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-migrate-decision-content-")),
    source = path.join(scratch, "legacy"),
    destination = path.join(scratch, "new");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    decisionContentFixture(source);
    initRepo(destination);
    cell = await openRepoCell({
      repoId: workspaceId("migration-decision-content-target"),
      rootDir: canonicalRoot(destination),
      ownerId: "migration-daemon",
      now: () => "2026-06-01T00:00:00.000Z",
    });
    const result = (await cell.run(
      { kind: "migrate-import", sourceRoots: sources(source) },
      { actor, source: "local" },
    )) as Record<string, unknown>;
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    const body = readFileSync(path.join(destination, "harness/decisions/decision-dec_CONTENT/decision.md"), "utf8");
    assert.match(body, /Preserve this rationale verbatim\./u);
    assert.match(body, /## Migrated source frontmatter[\s\S]*contentPins:[\s\S]*sha256:aaaaaaaa/u);
  } finally {
    await cell?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
