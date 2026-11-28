// harness-test-tier: fast
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  runtimeEventContentClaims,
  type AgentRuntimeEventV1,
} from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import { RAW_ARTIFACT_POLICY_ID } from "@harness-anything/kernel/internal/domain/artifact-text-classification.ts";
import {
  docByteLength,
  docSyncWritePlan,
  type DocEventV1,
  type PersistedCanonicalEventV1,
} from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { compileEntityPinEvent } from "@harness-anything/kernel/internal/domain/entity-pin-event.ts";
import { createScheduleV1, type ScheduleV1 } from "@harness-anything/kernel/internal/domain/schedule.ts";
import { compileScheduleDefinitionEvent } from "@harness-anything/kernel/internal/domain/schedule-event.ts";
import { readSettingsFacet, writeRepositorySettingsFacet } from "@harness-anything/kernel/internal/domain/settings.ts";
import { compileSettingsChangedEvent } from "@harness-anything/kernel/internal/domain/settings-event.ts";
import { taskLifecycleWritePlan } from "@harness-anything/kernel/internal/domain/task-lifecycle-publication.ts";
import { sha256Bytes, sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import type { CanonicalWriteBundle } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import { taskProjectionSchemaVersion } from "../../src/projection/projection-schema.ts";
import {
  makeTaskProjection,
  makeTaskProjectionReader,
  ProjectionEventSourceError,
} from "../../src/projection/rebuildable-task-projection.ts";
import { sqliteLedgerPath } from "../../src/store/sqlite-ledger-layout.ts";
import { canonicalEventWritePlan, makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";
import { initRepo } from "./task-event-store.fixtures.ts";

const actor = { principal: { personId: "person-s4" }, executor: null } as const;

function assertSlimEventIndexDatabase(projectionPath: string): void {
  const db = new DatabaseSync(projectionPath, { readOnly: true });
  try {
    const columns = (db.prepare("PRAGMA table_info(event_index)").all() as { readonly name: string }[]).map(
      ({ name }) => name,
    );
    assert.equal(columns.includes("event_json"), false, "event_index must not store event_json in schema v41");
    for (const required of [
      "op_id",
      "workspace_revision",
      "task_id",
      "event_schema",
      "event_type",
      "occurred_at",
      "occurred_at_ms",
      "runtime_session_id",
      "dispatch_id",
      "dispatch_key",
      "agent_id",
      "squad_id",
      "execution_id",
      "attempt_group_id",
      "dispatch_activity_at",
      "dispatch_activity_ms",
    ]) {
      assert.equal(columns.includes(required), true, `event_index missing scalar column ${required}`);
    }
    const jsonExtractObjects = db
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND tbl_name = 'event_index' AND lower(sql) LIKE '%event_json%'",
      )
      .all();
    assert.deepEqual(
      jsonExtractObjects,
      [],
      `event_index must have zero indexes or triggers referencing event_json, found: ${JSON.stringify(jsonExtractObjects)}`,
    );
    const triggersReferencingEventIndexJson = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL AND lower(sql) LIKE '%event_index%' AND lower(sql) LIKE '%event_json%'",
      )
      .all();
    assert.deepEqual(
      triggersReferencingEventIndexJson,
      [],
      `no trigger may reference event_index.event_json, found: ${JSON.stringify(triggersReferencingEventIndexJson)}`,
    );
  } finally {
    db.close();
  }
}

function downgradeProjectionToLegacyEventIndex(
  projectionPath: string,
  ledgerPath: string,
  targetVersion: 39 | 40,
  readBlob?: (sha256: string) => Uint8Array | null,
): void {
  const ledger = new DatabaseSync(ledgerPath, { readOnly: true });
  const db = new DatabaseSync(projectionPath);
  try {
    const ledgerEvents = new Map<number, string>();
    for (const row of ledger.prepare("SELECT revision, event_json FROM event ORDER BY revision").all() as {
      readonly revision: number;
      readonly event_json: string;
    }[]) {
      ledgerEvents.set(Number(row.revision), row.event_json.trimEnd());
    }
    const existingRows = db
      .prepare("SELECT op_id, workspace_revision, task_id FROM event_index ORDER BY workspace_revision")
      .all() as {
      readonly op_id: string;
      readonly workspace_revision: number;
      readonly task_id: string | null;
    }[];
    const existingIndexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='event_index' AND sql IS NOT NULL")
      .all() as { readonly name: string }[];
    db.exec("BEGIN");
    db.exec(`
      DROP TRIGGER IF EXISTS document_artifact_insert;
      DROP TRIGGER IF EXISTS document_artifact_update;
      DROP TRIGGER IF EXISTS document_artifact_delete;
      DROP TRIGGER IF EXISTS event_summary_read_index_insert_v2;
      DROP TRIGGER IF EXISTS event_summary_read_index_update_v2;
      DROP TRIGGER IF EXISTS runtime_dispatch_presence_0;
      DROP TRIGGER IF EXISTS runtime_dispatch_session_present;
      DROP TRIGGER IF EXISTS runtime_dispatch_session_absent;
    `);
    for (const { name } of existingIndexes) db.exec(`DROP INDEX IF EXISTS "${name}"`);
    db.exec(`
      DROP TABLE event_index;
      CREATE TABLE event_index (
        op_id TEXT PRIMARY KEY,
        workspace_revision INTEGER NOT NULL UNIQUE,
        task_id TEXT,
        event_json TEXT NOT NULL,
        runtime_session_present INTEGER,
        dispatch_key TEXT
      );
      CREATE INDEX event_index_task_id ON event_index (task_id);
      CREATE INDEX event_index_task_completed ON event_index (task_id, workspace_revision)
        WHERE json_extract(event_json, '$.schema') = 'task-event/v1'
          AND json_extract(event_json, '$.type') = 'task_completed';
      CREATE INDEX event_index_runtime_dispatch_id ON event_index (json_extract(event_json, '$.payload.dispatchId'))
        WHERE json_extract(event_json, '$.schema') = 'agent-runtime-event/v1';
      CREATE TRIGGER runtime_dispatch_presence_1 AFTER UPDATE OF event_json ON event_index BEGIN
        UPDATE event_index SET runtime_session_present = 0 WHERE op_id = NEW.op_id;
      END;
    `);
    const insertLegacy = db.prepare(
      "INSERT INTO event_index(op_id, workspace_revision, task_id, event_json, runtime_session_present, dispatch_key) VALUES (?, ?, ?, ?, 0, '')",
    );
    for (const row of existingRows) {
      const eventJson = ledgerEvents.get(Number(row.workspace_revision));
      assert.ok(eventJson, `ledger must have revision ${row.workspace_revision}`);
      insertLegacy.run(row.op_id, Number(row.workspace_revision), row.task_id, eventJson);
    }
    if (targetVersion === 39 && readBlob) {
      for (const table of ["document", "document_history"] as const) {
        const docs = db.prepare(`SELECT path, value_json FROM ${table}`).all() as {
          readonly path: string;
          readonly value_json: string;
        }[];
        const update = db.prepare(`UPDATE ${table} SET value_json = ? WHERE path = ?`);
        for (const doc of docs) {
          const parsed = JSON.parse(doc.value_json) as { readonly blobSha256: string };
          const body = Buffer.from(readBlob(parsed.blobSha256)!).toString("utf8");
          update.run(JSON.stringify({ ...parsed, body }), doc.path);
        }
      }
    }
    db.prepare("UPDATE projection_meta SET schema_version = ? WHERE singleton = 1").run(targetVersion);
    db.exec("COMMIT");
  } finally {
    db.close();
    ledger.close();
  }
}

function seedComprehensiveS4Ledger(rootDir: string, repoId: string) {
  initRepo(rootDir);
  const eventStore = makeTaskEventStore({ repoId, rootDir });
  const bundles: Array<{
    readonly event: PersistedCanonicalEventV1;
    readonly plan: CanonicalWriteBundle["plan"];
  }> = [];
  const append = (bundle: CanonicalWriteBundle) => {
    eventStore.append(bundle);
    bundles.push({ event: bundle.event, plan: bundle.plan });
  };
  let rev = 0;
  const nextRev = () => ++rev;
  const at = (minute: number) => `2026-11-28T05:${String(minute).padStart(2, "0")}:00.000Z`;
  const runtimePlan = (event: AgentRuntimeEventV1) => canonicalEventWritePlan(event, "agent-runtime/v1", event.opId);

  // 1. Task lifecycle events (created -> started -> submitted -> reviewed -> completed)
  const lifecycle = lifecycleFixture().events;
  for (const raw of lifecycle) {
    const r = nextRev();
    const event = {
      ...raw,
      workspaceRevision: r,
      occurredAt: at(r),
    } as typeof raw;
    append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
  }
  const taskId = lifecycle[0]!.taskId;
  const submittedEvent = bundles.find(({ event }) => event.type === "execution_submitted")!.event;

  // 2. Settings event
  const settingsRev = nextRev();
  const baseHarnessYaml = [
    "schema: harness-anything/v1",
    "name: s4-slim",
    "layout:",
    "  authoredRoot: harness",
    "settings:",
    "  defaultVertical: software/coding",
    "  defaultPreset: standard-task",
    "  defaultProfile: baseline",
    "  locale: en-US",
    "  tasks:",
    "    wipLimit: 60",
    "  scaffolds:",
    "    task: governance/task-scaffold.json",
    "    repository: governance/repository-scaffold.json",
    "",
  ].join("\n");
  const settings = readSettingsFacet(baseHarnessYaml);
  const candidateHarnessYaml = writeRepositorySettingsFacet(baseHarnessYaml, settings);
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness", "harness.yaml"), baseHarnessYaml, "utf8");
  append(
    compileSettingsChangedEvent({
      settings,
      baseDocumentBody: baseHarnessYaml,
      candidateDocumentBody: candidateHarnessYaml,
      eventId: "ev-settings-s4",
      opId: "op-settings-s4",
      workspaceRevision: settingsRev,
      actor,
      source: "local",
      occurredAt: at(settingsRev),
    }),
  );

  // 3. Schedule event
  const scheduleRev = nextRev();
  const schedule: ScheduleV1 = createScheduleV1({
    scheduleId: "schedule-s4",
    name: "S4 Heartbeat",
    mode: "detect",
    spec: {
      trigger: { kind: "interval", everyMs: 1_800_000, anchorAt: at(scheduleRev) },
      target: { kind: "agent", agentId: "agent-s4" },
      mission: "Verify S4",
    },
    actor,
    occurredAt: at(scheduleRev),
  });
  const scheduleBundle = compileScheduleDefinitionEvent({
    eventId: "ev-schedule-s4",
    workspaceRevision: scheduleRev,
    opId: "op-schedule-s4",
    type: "schedule_created",
    actor,
    source: "local",
    occurredAt: at(scheduleRev),
    schedule,
  });
  append(scheduleBundle);

  // 4. Agent runtime events: dispatch + session start + control request + control receipt + outcome
  const sessionId = "runtime-session-s4";
  const dispatchId = "dispatch-s4-001";
  const dispatchKey = "dispatch-key-s4-001";
  const attemptGroupId = "attempt-group-s4-001";
  const defSnapshotRef = "artifact:runtime-definitions/s4/v1";
  const defSnapshot = {
    schema: "agent-definition-snapshot/v1",
    configVersion: 1,
    instanceId: "claude-s4",
    installationId: "install-s4",
    kindId: "claude",
    providerId: "anthropic",
    model: "claude-s4",
    reasoningEffort: null,
    endpointKind: "official",
    baseUrlHash: null,
    authMode: "subscription",
  };
  const dispatch1: AgentRuntimeEventV1 = {
    schema: "agent-runtime-event/v1",
    eventId: "ev-dispatch-1",
    workspaceRevision: nextRev(),
    opId: "op-dispatch-1",
    type: "runtime_dispatch_requested",
    actor,
    source: { kind: "node", nodeId: "edge-node-s4" },
    occurredAt: at(rev),
    payload: {
      dispatchId,
      dispatchKey,
      attemptGroupId,
      runtimeSessionId: sessionId,
      instanceId: "claude-s4",
      installationId: "install-s4",
      kindId: "claude",
      definitionSnapshotRef: defSnapshotRef,
      definitionSnapshot: defSnapshot,
      agentId: "agent-s4",
      agentName: "Agent S4",
      squadId: "squad-s4",
      taskId,
      executionId: "execution-1",
      startedAt: at(rev),
      reviewTarget: { kind: "decision", decisionId: "dec_S4_REVIEW", digest: "a".repeat(64) },
    } as never,
  };
  append({ event: dispatch1, plan: runtimePlan(dispatch1), blobs: [] });

  const sessionStarted: AgentRuntimeEventV1 = {
    schema: "agent-runtime-event/v1",
    eventId: "ev-session-started-1",
    workspaceRevision: nextRev(),
    opId: "op-session-started-1",
    type: "runtime_session_started",
    actor,
    source: { kind: "node", nodeId: "edge-node-s4" },
    occurredAt: at(rev),
    payload: {
      runtimeSessionId: sessionId,
      instanceId: "claude-s4",
      installationId: "install-s4",
      kindId: "claude",
      definitionSnapshotRef: defSnapshotRef,
      launchGeneration: 1,
      attachable: true,
    } as never,
  };
  append({ event: sessionStarted, plan: runtimePlan(sessionStarted), blobs: [] });

  const controlCancel: AgentRuntimeEventV1 = {
    schema: "agent-runtime-event/v1",
    eventId: "ev-control-cancel-1",
    workspaceRevision: nextRev(),
    opId: "op-control-cancel-1",
    type: "runtime_session_liveness_changed",
    actor,
    source: "local",
    occurredAt: at(rev),
    payload: {
      runtimeSessionId: sessionId,
      liveness: "live",
      controlRequest: {
        controlRequestId: "ctrl-s4-1",
        action: "cancel",
        targetNodeId: "edge-node-s4",
      },
    } as never,
  };
  append({ event: controlCancel, plan: runtimePlan(controlCancel), blobs: [] });

  const controlReceipt: AgentRuntimeEventV1 = {
    schema: "agent-runtime-event/v1",
    eventId: "ev-control-receipt-1",
    workspaceRevision: nextRev(),
    opId: "op-control-receipt-1",
    type: "runtime_session_liveness_changed",
    actor,
    source: { kind: "node", nodeId: "edge-node-s4" },
    occurredAt: at(rev),
    payload: {
      runtimeSessionId: sessionId,
      liveness: "live",
      controlReceipt: {
        action: "steer",
        controlRequestId: "ctrl-s4-2",
        requestOpId: "op-req-s4-2",
        status: "applied",
        steerVersion: 2,
      },
    } as never,
  };
  append({ event: controlReceipt, plan: runtimePlan(controlReceipt), blobs: [] });

  const dispatch2: AgentRuntimeEventV1 = {
    schema: "agent-runtime-event/v1",
    eventId: "ev-dispatch-2",
    workspaceRevision: nextRev(),
    opId: "op-dispatch-2",
    type: "runtime_dispatch_requested",
    actor,
    source: { kind: "node", nodeId: "edge-node-s4" },
    occurredAt: at(rev),
    payload: {
      dispatchId: "dispatch-s4-002",
      dispatchKey: "dispatch-key-s4-002",
      resumedFromDispatchId: dispatchId,
      attemptGroupId,
      runtimeSessionId: sessionId,
      instanceId: "claude-s4",
      installationId: "install-s4",
      kindId: "claude",
      definitionSnapshotRef: defSnapshotRef,
      definitionSnapshot: defSnapshot,
      agentId: "agent-s4",
      agentName: "Agent S4",
      squadId: "squad-s4",
      taskId,
      executionId: "execution-1",
      startedAt: at(rev),
    } as never,
  };
  append({ event: dispatch2, plan: runtimePlan(dispatch2), blobs: [] });

  const outcomeResultText = "fixture result";
  const outcomeResultSha = sha256Text(outcomeResultText);
  const outcome1: AgentRuntimeEventV1 = {
    schema: "agent-runtime-event/v1",
    eventId: "ev-outcome-1",
    workspaceRevision: nextRev(),
    opId: "op-outcome-1",
    type: "runtime_session_outcome_observed",
    actor,
    source: { kind: "node", nodeId: "edge-node-s4" },
    occurredAt: at(rev),
    payload: {
      runtimeSessionId: sessionId,
      dispatchId,
      outcome: "succeeded",
      exitCode: 0,
      resultRef: `artifact:runtime-result/sha256/${outcomeResultSha}`,
      result: {
        sha256: outcomeResultSha,
        size: Buffer.byteLength(outcomeResultText),
        mediaType: "text/plain; charset=utf-8",
      },
      runtimeMetrics: {
        inputTokens: 120,
        cacheReadTokens: 0,
        outputTokens: 45,
        totalTokens: 165,
        toolCallCount: 1,
        usageUnavailable: false,
      },
    } as never,
  };
  append({
    event: outcome1,
    plan: runtimePlan(outcome1),
    blobs: runtimeEventContentClaims(outcome1).map((claim) => ({ ...claim, body: outcomeResultText })),
  });

  // 5. Pin event + artifact doc event
  const pinRev = nextRev();
  append(
    compileEntityPinEvent({
      entityRef: `task/${taskId}`,
      pinned: true,
      eventId: "ev-pin-s4",
      opId: "op-pin-s4",
      workspaceRevision: pinRev,
      actor,
      source: "local",
      occurredAt: at(pinRev),
    }),
  );

  const artifactBytes = Uint8Array.from([0x00, 0xff, 0xfe, 0x42, 0x53, 0x34]);
  const artifactSha = sha256Bytes(artifactBytes);
  const docEvent: DocEventV1 = {
    schema: "doc-event/v1",
    eventId: "ev-doc-s4",
    workspaceRevision: nextRev(),
    opId: "op-doc-s4",
    type: "documents_written",
    actor,
    source: "local",
    occurredAt: at(rev),
    payload: {
      executionId: null,
      baseLedgerSha: eventStore.currentCut(),
      changes: [
        {
          path: "tasks/task_s4-fixture/artifacts/s4-report.bin" as DocEventV1["payload"]["changes"][number]["path"],
          baseBlobSha256: null,
          policyId: RAW_ARTIFACT_POLICY_ID,
          candidate: {
            sha256: artifactSha,
            size: docByteLength(artifactBytes.byteLength),
            mediaType: "application/octet-stream" as unknown as "text/plain",
          },
          regionProofs: [],
        },
      ],
    },
  };
  append({
    event: docEvent,
    plan: docSyncWritePlan(docEvent),
    blobs: [
      {
        sha256: artifactSha,
        size: artifactBytes.byteLength,
        mediaType: "application/octet-stream",
        body: artifactBytes,
      },
    ],
  });

  return {
    eventStore,
    bundles,
    totalRevisions: rev,
    taskId,
    submittedOpId: submittedEvent.opId,
    sessionId,
    dispatchId,
    dispatchKey,
    attemptGroupId,
  };
}

test("v40->v41 and v39->v40->v41 in-place upgrades eliminate event_json/json_extract indexes and match incremental & cold rebuild stateDigest byte-for-byte", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    const seeded = seedComprehensiveS4Ledger(rootDir, "s4-slim-upgrade");
    const ledgerPath = sqliteLedgerPath(rootDir, 3);
    const incrementalPath = path.join(rootDir, ".harness", "cache", "incremental-v41.sqlite");
    const rebuildPath = path.join(rootDir, ".harness", "cache", "rebuild-v41.sqlite");
    const upgradedV40Path = path.join(rootDir, ".harness", "cache", "upgraded-from-v40.sqlite");
    const upgradedV39Path = path.join(rootDir, ".harness", "cache", "upgraded-from-v39.sqlite");

    // 1. Incremental apply
    const incremental = makeTaskProjection({ rootDir, projectionPath: incrementalPath, eventStore: seeded.eventStore });
    for (const { event, plan } of seeded.bundles) incremental.apply(event, plan);
    const incrementalDigest = incremental.readStateDigest();
    assert.ok(incrementalDigest !== null);
    incremental.close();
    assertSlimEventIndexDatabase(incrementalPath);

    // 2. Cold rebuild
    const rebuilt = makeTaskProjection({ rootDir, projectionPath: rebuildPath, eventStore: seeded.eventStore });
    const rebuildReceipt = rebuilt.rebuild();
    assert.equal(rebuildReceipt.watermark, seeded.totalRevisions);
    assert.equal(rebuildReceipt.stateDigest, incrementalDigest);
    rebuilt.close();
    assertSlimEventIndexDatabase(rebuildPath);

    // 3. Prepare genuine v40 & v39 legacy caches and upgrade both in place
    copyFileSync(incrementalPath, upgradedV40Path);
    downgradeProjectionToLegacyEventIndex(upgradedV40Path, ledgerPath, 40);
    copyFileSync(incrementalPath, upgradedV39Path);
    downgradeProjectionToLegacyEventIndex(upgradedV39Path, ledgerPath, 39, seeded.eventStore.readContentBlob);

    for (const [label, upgradePath] of [
      ["v40->v41", upgradedV40Path],
      ["v39->v40->v41", upgradedV39Path],
    ] as const) {
      const progressEvents: Array<{ readonly applied: number; readonly total: number }> = [];
      const logged = t.mock.method(console, "error", () => undefined);
      const upgraded = makeTaskProjection({
        rootDir,
        projectionPath: upgradePath,
        eventStore: seeded.eventStore,
        onValidationProgress: (progress) => progressEvents.push(progress),
      });
      try {
        assert.equal(logged.mock.callCount(), 0, `${label} in-place upgrade must not discard/replay cache`);
        assert.ok(progressEvents.length > 0, `${label} in-place upgrade must emit validation progress`);
        assert.equal(progressEvents.at(-1)!.applied, progressEvents.at(-1)!.total);
        assertSlimEventIndexDatabase(upgradePath);

        const inspectDb = new DatabaseSync(upgradePath, { readOnly: true });
        try {
          const meta = inspectDb.prepare("SELECT schema_version FROM projection_meta WHERE singleton = 1").get() as {
            readonly schema_version: number;
          };
          assert.equal(Number(meta.schema_version), taskProjectionSchemaVersion);
          assert.equal(taskProjectionSchemaVersion, 41);
        } finally {
          inspectDb.close();
        }
        assert.equal(
          upgraded.readStateDigest(),
          incrementalDigest,
          `${label} upgraded stateDigest must be byte-identical to incremental and cold rebuild`,
        );
      } finally {
        logged.mock.restore();
        upgraded.close();
      }
    }
    await seeded.eventStore.drain();
  });
});

test("scalarized event_index serves full query parity with 1 batched ledger call per page and 0 calls for scalar queries", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const seeded = seedComprehensiveS4Ledger(rootDir, "s4-query-parity");
    const projectionPath = path.join(rootDir, ".harness", "cache", "task.sqlite");
    let ledgerBatchCalls = 0;
    const countedStore = {
      ...seeded.eventStore,
      readEventsByRevisions: (revisions: readonly number[]) => {
        ledgerBatchCalls += 1;
        return seeded.eventStore.readEventsByRevisions(revisions);
      },
    };
    const projection = makeTaskProjection({ rootDir, projectionPath, eventStore: countedStore });
    const reader = makeTaskProjectionReader({ rootDir, projectionPath });
    try {
      projection.rebuild();
      const assertQueries = (queries: typeof projection, checkCounts: boolean) => {
        // Pure-scalar queries: ZERO ledger hydration calls
        ledgerBatchCalls = 0;
        assert.equal(queries.countRuntimeDispatchesByAgent("agent-s4"), 2);
        assert.equal(queries.readTaskSubmissionOperation(seeded.taskId, "execution-1"), seeded.submittedOpId);
        assert.equal(queries.readTaskEventExists(seeded.taskId), true);
        assert.equal(queries.listPinnedEntities("person-s4").length >= 1, true);
        const list = queries.list({ limit: 5 });
        assert.equal(list.rows.length, 1);
        assert.ok(list.rows[0]!.createdAt);
        assert.ok(list.rows[0]!.completedAt);
        const fleet = queries.readEventSummaries(0, 50, { fleetNodeIds: ["edge-node-s4"] });
        assert.equal(fleet.fleetActivity?.[0]?.recentDispatches.length, 2);
        assert.equal(fleet.fleetActivity?.[0]?.recentDispatches[0]?.agentLabel, "Agent S4");
        if (checkCounts) assert.equal(ledgerBatchCalls, 0, "pure-scalar reads must not hit ledger.sqlite");

        // Multi-row hydrated queries: 1 batched ledger call per page!
        ledgerBatchCalls = 0;
        const canonical = queries.readCanonicalEvents(0, 50);
        assert.equal(canonical.events.length, seeded.totalRevisions);
        if (checkCounts) assert.equal(ledgerBatchCalls, 1, "readCanonicalEvents must batch all revisions in 1 call");

        ledgerBatchCalls = 0;
        const dispatchPage = queries.readRuntimeDispatchPage({
          startedAtGte: "",
          order: "asc",
          limit: 10,
        });
        assert.equal(dispatchPage.rows.length, 2);
        assert.equal(dispatchPage.rows[0]!.event.payload.dispatchId, seeded.dispatchId);
        assert.equal(dispatchPage.rows[0]!.outcome, "succeeded");
        assert.equal(dispatchPage.rows[0]!.metrics?.inputTokens, 120);
        if (checkCounts)
          assert.equal(ledgerBatchCalls, 1, "readRuntimeDispatchPage must batch dispatches + outcomes in 1 call");

        ledgerBatchCalls = 0;
        const memberPage = queries.readRuntimeDispatchesByMember({
          agentId: "agent-s4",
          nodeId: "edge-node-s4",
          limit: 10,
        });
        assert.equal(memberPage.rows.length, 2);
        assert.equal(memberPage.sessions.length, 1);
        assert.equal(memberPage.sessions[0]!.runtimeSessionId, seeded.sessionId);
        if (checkCounts) assert.equal(ledgerBatchCalls, 1);

        // Point and filtered hydrated queries
        assert.equal(queries.readOperation("op-dispatch-1")?.event.opId, "op-dispatch-1");
        assert.equal(queries.readTaskOperation(seeded.submittedOpId)?.event.opId, seeded.submittedOpId);
        assert.equal(queries.readTaskOperation("op-dispatch-1"), null);
        assert.equal(queries.readSettingsEvent()?.opId, "op-settings-s4");
        assert.equal(queries.readScheduleEvents("schedule-s4").events.length, 1);
        assert.equal(queries.readScheduleEvents().events.length, 1);
        assert.equal(
          queries.readReckoningEvents({
            type: "runtime_dispatch_requested",
            after: "2026-11-28T00:00:00.000Z",
            before: "2026-11-28T23:59:59.000Z",
          }).length,
          2,
        );
        assert.equal(
          queries.readRuntimeDispatch(seeded.sessionId, "artifact:runtime-definitions/s4/v1")?.payload.dispatchId,
          seeded.dispatchId,
        );
        assert.equal(queries.readRuntimeDispatchById(seeded.dispatchId)?.outcome, "succeeded");
        assert.equal(
          queries.readRuntimeDispatchByDispatchKey(seeded.dispatchKey)?.event.payload.dispatchId,
          seeded.dispatchId,
        );
        assert.equal(
          queries.readRuntimeDispatchByResumeSource(seeded.dispatchId)?.event.payload.dispatchId,
          "dispatch-s4-002",
        );
        assert.equal(queries.readRuntimeDispatchesBySession(seeded.sessionId).length, 2);
        assert.equal(queries.readRuntimeDispatchEventsBySession(seeded.sessionId).length, 2);
        assert.equal(queries.readRuntimeDispatchesByTaskIds([seeded.taskId]).length, 2);
        assert.equal(queries.readLatestRuntimeDispatchesByTaskIds([seeded.taskId]).length, 1);
        assert.equal(
          queries.readLatestRuntimeDispatchBySession(seeded.sessionId)?.payload.dispatchId,
          "dispatch-s4-002",
        );
        assert.equal(queries.readRuntimeDispatchByDispatchIdPrefix("dispatch-s4-", 10).length, 2);
        assert.equal(queries.readRuntimeDispatchesByTaskExecution(seeded.taskId, "execution-1").length, 2);
        assert.equal(queries.readRuntimeDispatchesByAttemptGroup(seeded.attemptGroupId).length, 2);
        assert.equal(queries.readRuntimeDispatchesByDecision("dec_S4_REVIEW").length, 1);
        assert.equal(queries.readRuntimeDispatchesByDecisions(["dec_S4_REVIEW"]).length, 1);
        assert.equal(queries.readRuntimeSessionEvents(seeded.sessionId, 0, 50).length, 6);
        assert.equal(
          queries.readRuntimeSessionEventsByType(seeded.sessionId, ["runtime_session_liveness_changed"], {
            filter: "cancel_control_request",
            limit: 10,
          }).length,
          1,
        );
        assert.equal(
          queries.readRuntimeSessionEventsByType(seeded.sessionId, ["runtime_session_liveness_changed"], {
            filter: "applied_steer_receipt",
            order: "desc",
            limit: 1,
          }).length,
          1,
        );
        assert.equal(
          queries.readRuntimeSessionEventsByType(seeded.sessionId, ["runtime_session_liveness_changed"], {
            filter: "control_receipt",
            requestOpId: "op-req-s4-2",
            limit: 1,
          }).length,
          1,
        );
        const basis = queries.readReplicaBasis(0);
        assert.equal(basis.events.length, seeded.totalRevisions);
        assert.equal(basis.headEvent?.workspaceRevision, seeded.totalRevisions);
      };

      assertQueries(projection, true);
      reader.withSession((queries) => assertQueries(queries as unknown as typeof projection, false));
    } finally {
      reader.close();
      projection.close();
      await seeded.eventStore.drain();
    }
  });
});

test("strict L3 fail-closed: missing ledger revision throws ProjectionEventSourceError instead of fabricating event data", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const seeded = seedComprehensiveS4Ledger(rootDir, "s4-fail-closed");
    const projectionPath = path.join(rootDir, ".harness", "cache", "task.sqlite");
    const projection = makeTaskProjection({ rootDir, projectionPath, eventStore: seeded.eventStore });
    projection.rebuild();
    const dispatchRev = projection.readOperation("op-dispatch-1")!.event.workspaceRevision;
    projection.close();
    await seeded.eventStore.drain();

    // Remove the referenced revision from ledger.sqlite to simulate a missing/corrupted event source.
    const ledgerDb = new DatabaseSync(sqliteLedgerPath(rootDir, 3));
    try {
      ledgerDb.exec("PRAGMA foreign_keys = OFF");
      ledgerDb.prepare("DELETE FROM event WHERE revision = ?").run(dispatchRev);
    } finally {
      ledgerDb.close();
    }

    const reader = makeTaskProjectionReader({ rootDir, projectionPath });
    try {
      reader.withSession((queries) => {
        for (const call of [
          () => queries.readOperation("op-dispatch-1"),
          () => queries.readRuntimeDispatchById(seeded.dispatchId),
          () => queries.readCanonicalEvents(0, 50),
          () => queries.readRuntimeSessionEvents(seeded.sessionId, 0, 50),
        ]) {
          assert.throws(call, (error: unknown) => {
            assert.ok(
              error instanceof ProjectionEventSourceError,
              `expected ProjectionEventSourceError, got ${String(error)}`,
            );
            assert.equal(error.code, "event_source_missing");
            assert.ok(error.missingRevisions.includes(dispatchRev));
            return true;
          });
        }
      });
    } finally {
      reader.close();
    }
  });
});
