// harness-test-tier: fast
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  compileDecisionWrite,
  DECISION_DOCUMENT_POLICY_ID,
  decisionWritePlan,
} from "@harness-anything/kernel/internal/domain/decision-event.ts";
import { compileFactWrite, factWritePlan } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import {
  compileRelationCreatedEvent,
  relationEventWritePlan,
} from "@harness-anything/kernel/internal/domain/relation-event.ts";
import { deriveRelationId } from "@harness-anything/kernel/internal/domain/entity-relation.ts";
import {
  DOC_CODEC_ID,
  DOC_POLICY_ID,
  docSyncWritePlan,
  type DocEventV1,
  type PersistedCanonicalEventV1,
} from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { taskLifecycleWritePlan } from "@harness-anything/kernel/internal/domain/task-lifecycle-publication.ts";
import type { AgentRuntimeEventV1 } from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import { compileEntityPinEvent } from "@harness-anything/kernel/internal/domain/entity-pin-event.ts";
import { OPAQUE_TEXTUAL_POLICY_ID } from "@harness-anything/kernel/internal/domain/artifact-text-classification.ts";
import type { EventStreamPort } from "@harness-anything/kernel/internal/ports/task-projection-source.ts";
import { createProjectionTables } from "../../src/projection/projection-tables.ts";
import { readDocumentBaseMetadata } from "../../src/projection/bulk-rebuild-state.ts";
import { ensureRuntimeMemberIndex } from "../../src/projection/runtime-member-index.ts";
import { withDatabase } from "../../src/projection/rebuildable-task-projection-database.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { canonicalEventWritePlan, makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { lifecycleFixture } from "../../../kernel/test/store/task-lifecycle-fixture.ts";
import { withTempStoreAsync } from "./helpers.ts";
import { initRepo } from "./task-event-store.fixtures.ts";
import { proposal } from "./relation-graph-projection.fixtures.ts";

interface MasterRow {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim();
}

function readSchemaFingerprint(dbPath: string): readonly MasterRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (
      db
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
        .all() as unknown as readonly MasterRow[]
    ).map((row) => ({
      type: row.type,
      name: row.name,
      tbl_name: row.tbl_name,
      sql: normalizeSql(row.sql),
    }));
  } finally {
    db.close();
  }
}

function readTableSnapshot(dbPath: string, sql: string): readonly Record<string, unknown>[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

function makeDocEvent(input: {
  readonly revision: number;
  readonly path: string;
  readonly body: string | null;
  readonly baseSha: string | null;
  readonly baseLedgerSha?: DocEventV1["payload"]["baseLedgerSha"];
  readonly mediaType?: string;
  readonly policyId?: string;
  readonly actorPersonId?: string;
  readonly occurredAt: string;
}): {
  readonly event: DocEventV1;
  readonly blobs: readonly {
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
    readonly body: string;
    readonly bytes: Uint8Array;
  }[];
} {
  const bytes = input.body === null ? null : new TextEncoder().encode(input.body);
  const sha = input.body === null ? null : sha256Text(input.body);
  const mediaType = input.mediaType ?? "text/markdown";
  const policyId = (input.policyId ?? DOC_POLICY_ID) as typeof DOC_POLICY_ID;
  const event: DocEventV1 = {
    schema: "doc-event/v1",
    eventId: `doc-event-${input.revision}`,
    workspaceRevision: input.revision,
    opId: `doc-op-${input.revision}`,
    type: "documents_written",
    actor: {
      principal: { personId: input.actorPersonId ?? "person-rebuild" },
      executor: { kind: "agent", id: "neon" },
    },
    source: "local",
    occurredAt: input.occurredAt,
    payload: {
      executionId: null,
      baseLedgerSha: input.baseLedgerSha ?? { repoId: "cold-rebuild-equivalence", sha: "0".repeat(40) },
      ...(input.body === null ? { retirementReason: "retired in equivalence fixture" } : {}),
      changes: [
        {
          path: input.path,
          policyId,
          baseBlobSha256: input.baseSha,
          candidate:
            bytes === null || sha === null
              ? null
              : {
                  sha256: sha,
                  size: bytes.byteLength,
                  mediaType,
                },
          regionProofs:
            bytes === null || sha === null || policyId !== DOC_POLICY_ID
              ? []
              : [
                  {
                    regionId: "heading/doc",
                    policyId,
                    codecId: DOC_CODEC_ID,
                    baseSha256: input.baseSha ?? sha256Text(""),
                    candidateSha256: sha,
                    insertBytes: bytes.byteLength,
                  },
                ],
        },
      ],
    },
  };
  return {
    event,
    blobs:
      bytes === null || sha === null || input.body === null
        ? []
        : [{ sha256: sha, size: bytes.byteLength, mediaType, body: input.body, bytes }],
  };
}

test("optimized cold rebuild is byte-identical to incremental apply across stateDigest, schema, triggers, and secondary indexes", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "cold-rebuild-equivalence", rootDir });
    const appliedBundles: Array<{ readonly event: PersistedCanonicalEventV1; readonly plan?: unknown }> = [];
    const appendAndRecord = (bundle: {
      readonly event: PersistedCanonicalEventV1;
      readonly plan?: unknown;
      readonly blobs?: readonly {
        readonly sha256: string;
        readonly body?: string;
        readonly bytes?: Uint8Array;
      }[];
    }) => {
      eventStore.append(bundle as Parameters<typeof eventStore.append>[0]);
      appliedBundles.push({ event: bundle.event, plan: bundle.plan });
    };

    const template = lifecycleFixture().events[0]!;
    assert.equal(template.type, "task_created");
    let rev = 1;
    const nextRev = () => rev++;
    const at = (n: number) => new Date(Date.UTC(2026, 10, 22, 0, 0, n)).toISOString();

    // 1. Two tasks: task_alpha and task_beta
    const taskAlpha = { ...template.payload.task, taskId: "task_alpha", title: "Alpha task" };
    const taskBeta = { ...template.payload.task, taskId: "task_beta", title: "Beta task" };
    const createAlpha: PersistedCanonicalEventV1 = {
      ...template,
      eventId: "ev-task-alpha",
      opId: "op-task-alpha",
      taskId: "task_alpha",
      workspaceRevision: nextRev(),
      occurredAt: at(1),
      source: { kind: "node", nodeId: "node-edge-1" },
      payload: { ...template.payload, task: taskAlpha },
    };
    appendAndRecord({ event: createAlpha, plan: taskLifecycleWritePlan(createAlpha), blobs: [] });

    const createBeta: PersistedCanonicalEventV1 = {
      ...template,
      eventId: "ev-task-beta",
      opId: "op-task-beta",
      taskId: "task_beta",
      workspaceRevision: nextRev(),
      occurredAt: at(2),
      payload: { ...template.payload, task: taskBeta },
    };
    appendAndRecord({ event: createBeta, plan: taskLifecycleWritePlan(createBeta), blobs: [] });

    // 2. Decision proposed + derives relation targeting task_alpha (creates freshness witness)
    const decRev1 = nextRev();
    const rawProposal = proposal(decRev1, "dec_EQUIV1");
    assert.equal(rawProposal.type, "decision_proposed");
    const decProposal = compileDecisionWrite({
      event: {
        ...rawProposal,
        payload: {
          ...rawProposal.payload,
          appliesTo: { modules: ["packages/storage/", ".\\tools\\gates"], productLines: [] },
          provenance: [
            {
              runtime: "codex",
              sessionId: "sess-equiv-decision",
              transcriptReachability: "by_session_id",
              boundAt: at(decRev1),
            },
          ],
        },
      },
      currentDecision: null,
      currentRelations: [],
      currentDocument: null,
      decisionReviewRequirement: "off",
    });
    appendAndRecord({ ...decProposal, plan: decisionWritePlan(decProposal.event) });

    // 3. Relations: derives (decision -> task_alpha) + depends-on cycle (task_alpha <-> task_beta)
    const makeRelation = (source: string, target: string, type: "derives" | "depends-on") => {
      const r = nextRev();
      const identity = { source, target, type, direction: "directed" as const };
      const relationId = deriveRelationId(identity);
      const ev = compileRelationCreatedEvent({
        record: {
          relation_id: relationId,
          ...identity,
          origin: "declared",
          rationale: `Equivalence ${type} relation`,
          state: "active",
          targetObservedVersion: type === "derives" ? 1 : null,
        },
        actor: { principal: { personId: "person-rebuild" }, executor: null },
        source: "local",
        opId: `op-rel-${r}`,
        occurredAt: at(r),
        workspaceRevision: r,
      });
      appendAndRecord({ event: ev, plan: relationEventWritePlan(ev), blobs: [] });
    };
    makeRelation("decision/dec_EQUIV1/CH1", "task/task_alpha", "derives");
    makeRelation("task/task_alpha", "task/task_beta", "depends-on");
    makeRelation("task/task_beta", "task/task_alpha", "depends-on");

    // 4. Advance task_alpha twice: rev A changes task_alpha revision (making derives stale),
    //    rev B reads snapshot_json for task_alpha (must observe stale freshness identically!).
    for (const suffix of ["first update", "second update"]) {
      const r = nextRev();
      const amend: PersistedCanonicalEventV1 = {
        ...template,
        eventId: `ev-amend-${r}`,
        opId: `op-amend-${r}`,
        taskId: "task_alpha",
        workspaceRevision: r,
        type: "task_amended",
        occurredAt: at(r),
        payload: {
          task: { ...taskAlpha, title: `Alpha ${suffix}` },
          mutation: { command: "amend", reason: suffix, fields: ["title"] },
          documentClaims: [],
        },
      } as PersistedCanonicalEventV1;
      appendAndRecord({ event: amend, plan: taskLifecycleWritePlan(amend), blobs: [] });
    }

    // 5. Documents: large repeated updates, artifact timeline HTML/MD, and retirement
    const docPath = "context/large-doc.md";
    const body1 = `# Report v1\n${"a".repeat(32_000)}\n`;
    const body2 = `# Report v2\n${"b".repeat(48_000)}\n`;
    const doc1 = makeDocEvent({
      revision: nextRev(),
      path: docPath,
      body: body1,
      baseSha: null,
      baseLedgerSha: eventStore.currentCut(),
      occurredAt: at(20),
    });
    appendAndRecord({ event: doc1.event, plan: docSyncWritePlan(doc1.event), blobs: doc1.blobs });
    const doc2 = makeDocEvent({
      revision: nextRev(),
      path: docPath,
      body: body2,
      baseSha: sha256Text(body1),
      baseLedgerSha: eventStore.currentCut(),
      occurredAt: at(21),
    });
    appendAndRecord({ event: doc2.event, plan: docSyncWritePlan(doc2.event), blobs: doc2.blobs });

    const htmlArtifact = makeDocEvent({
      revision: nextRev(),
      path: "tasks/task_alpha-alpha-task/artifacts/explainer.html",
      body: "<html><body><h1>Equivalence</h1></body></html>",
      baseSha: null,
      baseLedgerSha: eventStore.currentCut(),
      mediaType: "text/html",
      policyId: OPAQUE_TEXTUAL_POLICY_ID,
      occurredAt: at(22),
    });
    appendAndRecord({
      event: htmlArtifact.event,
      plan: docSyncWritePlan(htmlArtifact.event),
      blobs: htmlArtifact.blobs,
    });

    const retiredDocPath = "context/ephemeral.md";
    const eph1 = makeDocEvent({
      revision: nextRev(),
      path: retiredDocPath,
      body: "temporary",
      baseSha: null,
      baseLedgerSha: eventStore.currentCut(),
      occurredAt: at(23),
    });
    appendAndRecord({ event: eph1.event, plan: docSyncWritePlan(eph1.event), blobs: eph1.blobs });
    const eph2 = makeDocEvent({
      revision: nextRev(),
      path: retiredDocPath,
      body: null,
      baseSha: sha256Text("temporary"),
      baseLedgerSha: eventStore.currentCut(),
      occurredAt: at(24),
    });
    appendAndRecord({ event: eph2.event, plan: docSyncWritePlan(eph2.event), blobs: eph2.blobs });

    // 6. Fact recorded + archived (moves fact document to document_history)
    const factRecRev = nextRev();
    const factRec = compileFactWrite({
      event: {
        schema: "fact-event/v1",
        eventId: `ev-fact-${factRecRev}`,
        workspaceRevision: factRecRev,
        opId: `op-fact-${factRecRev}`,
        taskId: "task_alpha",
        factId: "F-11223344",
        type: "fact_recorded",
        actor: { principal: { personId: "person-rebuild" }, executor: null },
        source: "local",
        occurredAt: at(factRecRev),
        payload: {
          statement: "Cold rebuild equivalence fact.",
          evidenceSource: "packages/storage/src/projection/projection-tables.ts:42",
          observedCommit: "a".repeat(40),
          observedAt: at(factRecRev),
          confidence: "high",
          memoryClass: "semantic",
          memoryTags: [],
          provenance: [
            {
              runtime: "codex",
              sessionId: "sess-equiv",
              transcriptReachability: "by_session_id",
              boundAt: at(factRecRev),
            },
          ],
        },
      },
    });
    appendAndRecord({ ...factRec, plan: factWritePlan(factRec.event) });

    const factArchRev = nextRev();
    const { factsDocumentClaim: _droppedClaim, ...archivedFactPayload } = factRec.event.payload;
    const factArchEvent: PersistedCanonicalEventV1 = {
      ...factRec.event,
      eventId: `ev-fact-arch-${factArchRev}`,
      workspaceRevision: factArchRev,
      opId: `op-fact-arch-${factArchRev}`,
      type: "fact_archived",
      occurredAt: at(factArchRev),
      payload: {
        ...archivedFactPayload,
        archiveReason: "archive into document_history",
        factsDocumentRetirement: {
          path: "facts/F-11223344.md",
          sha256: factRec.event.payload.factsDocumentClaim!.sha256,
        },
      },
    };
    appendAndRecord({ event: factArchEvent, plan: factWritePlan(factArchEvent), blobs: [] });

    // 7. Pin entity
    const pinRev = nextRev();
    const pinBundle = compileEntityPinEvent({
      entityRef: "task/task_alpha",
      pinned: true,
      eventId: `ev-pin-${pinRev}`,
      opId: `op-pin-${pinRev}`,
      workspaceRevision: pinRev,
      actor: { principal: { personId: "person-rebuild" }, executor: null },
      source: "local",
      occurredAt: at(pinRev),
    });
    appendAndRecord(pinBundle);

    // 8. Agent runtime session launched on edge node + dispatch requested from that session
    const launchRev = nextRev();
    const sessionStarted: AgentRuntimeEventV1 = {
      schema: "agent-runtime-event/v1",
      eventId: `ev-rt-start-${launchRev}`,
      opId: `op-rt-start-${launchRev}`,
      workspaceRevision: launchRev,
      type: "runtime_session_started",
      actor: { principal: { personId: "person-rebuild" }, executor: null },
      source: { kind: "node", nodeId: "node-edge-1" },
      occurredAt: at(launchRev),
      payload: {
        runtimeSessionId: "runtime_equiv_1",
        instanceId: "claude-fixture",
        installationId: "installation-claude",
        kindId: "claude",
        definitionSnapshotRef: "artifact:runtime-definitions/claude/v1",
        launchGeneration: 1,
        attachable: false,
      },
    } as AgentRuntimeEventV1;
    appendAndRecord({
      event: sessionStarted,
      plan: canonicalEventWritePlan(sessionStarted, "agent-runtime/v1", sessionStarted.opId),
      blobs: [],
    });

    const dispatchRev = nextRev();
    const dispatchRequested: AgentRuntimeEventV1 = {
      schema: "agent-runtime-event/v1",
      eventId: `ev-rt-disp-${dispatchRev}`,
      opId: `op-rt-disp-${dispatchRev}`,
      workspaceRevision: dispatchRev,
      type: "runtime_dispatch_requested",
      actor: { principal: { personId: "person-rebuild" }, executor: { kind: "agent", id: "neon" } },
      source: "local",
      occurredAt: at(dispatchRev),
      payload: {
        dispatchId: "dispatch_equiv_1",
        attemptGroupId: "group_equiv_1",
        runtimeSessionId: "runtime_equiv_1",
        instanceId: "claude-fixture",
        installationId: "installation-claude",
        kindId: "claude",
        agentId: "neon",
        taskId: "task_alpha",
        executionId: "exe_equiv_1",
        dispatchKey: "dk-equiv-1",
        startedAt: at(dispatchRev),
        definitionSnapshotRef: "artifact:runtime-definitions/claude/v1",
        definitionSnapshot: {
          schema: "agent-definition-snapshot/v1",
          configVersion: 1,
          instanceId: "claude-fixture",
          installationId: "installation-claude",
          kindId: "claude",
          providerId: "anthropic",
          model: "claude-fixture",
          reasoningEffort: null,
          endpointKind: "official",
          baseUrlHash: null,
          authMode: "subscription",
        },
      },
    } as AgentRuntimeEventV1;
    appendAndRecord({
      event: dispatchRequested,
      plan: canonicalEventWritePlan(dispatchRequested, "agent-runtime/v1", dispatchRequested.opId),
      blobs: [],
    });

    // Build Projection A via event-by-event incremental apply
    const incrementalPath = path.join(rootDir, ".harness/cache/incremental.sqlite");
    const rebuiltPath = path.join(rootDir, ".harness/cache/rebuilt.sqlite");
    const incremental = makeTaskProjection({ rootDir, eventStore, projectionPath: incrementalPath });
    const validationProgress: Array<{ readonly applied: number; readonly total: number }> = [];
    const replayProgress: Array<{ readonly applied: number; readonly total?: number; readonly watermark: number }> = [];
    const rebuilt = makeTaskProjection({
      rootDir,
      eventStore,
      projectionPath: rebuiltPath,
      catchUpLimit: 4,
      onProgress: (p) => replayProgress.push(p),
      onValidationProgress: (p) => validationProgress.push(p),
    });

    try {
      for (const item of appliedBundles) incremental.apply(item.event, item.plan as never);
      const receipt = rebuilt.rebuild();
      const incrementalDigest = incremental.readStateDigest();

      assert.ok(incrementalDigest !== null);
      assert.equal(receipt.stateDigest, incrementalDigest, "rebuild stateDigest must match incremental apply");
      assert.equal(rebuilt.readStateDigest(), incrementalDigest);
      assert.deepEqual(rebuilt.readRelationCycleAudit(), incremental.readRelationCycleAudit());
      assert.equal(receipt.relationCycleAudit.scannedEdges, incremental.readRelationCycleAudit().scannedEdges);
      assert.deepEqual(receipt.relationCycleAudit.issues, incremental.readRelationCycleAudit().issues);
      assert.equal(receipt.relationCycleAudit.issues.length, 1);

      // Verify progress callbacks fired during both replay and deferred index build
      assert.ok(replayProgress.length > 0);
      assert.equal(replayProgress.at(-1)!.watermark, appliedBundles.length);
      assert.ok(
        validationProgress.length > 50,
        `expected >50 index-build progress steps, got ${validationProgress.length}`,
      );
      assert.equal(validationProgress.at(-1)!.applied, validationProgress.at(-1)!.total);

      // Verify exact schema/index/trigger parity (no missing indexes or triggers!)
      assert.deepEqual(readSchemaFingerprint(rebuiltPath), readSchemaFingerprint(incrementalPath));

      // Verify derived tables & columns that live outside or alongside stateDigest
      for (const query of [
        "SELECT workspace_revision, event_type, occurred_at, actor_person_id, actor_executor_id, source_node_id, activity_task_id, dispatch_started_at, read_index_version FROM event_summary ORDER BY workspace_revision",
        "SELECT entity_ref, workspace_revision FROM event_summary_entity_ref ORDER BY entity_ref, workspace_revision",
        "SELECT node_id, task_id, revision, person_id, updated_at FROM fleet_node_task ORDER BY node_id, task_id",
        "SELECT op_id, runtime_session_present, dispatch_key FROM event_index ORDER BY op_id",
        "SELECT relation_id, freshness, current_target_version FROM relation_edge ORDER BY relation_id",
        "SELECT ref FROM relation_freshness_dirty ORDER BY ref",
        "SELECT relation_type, node_ref FROM relation_cycle_dirty ORDER BY relation_type, node_ref",
        "SELECT status, count FROM workspace_task_census ORDER BY status",
        "SELECT path, package_dir, relative, kind, sort_ms, occurred_at, size_bytes FROM artifact_document ORDER BY path",
        "SELECT kind, total FROM artifact_count ORDER BY kind",
        "SELECT module_prefix, decision_id FROM decision_applies_module ORDER BY module_prefix, decision_id",
      ]) {
        assert.deepEqual(readTableSnapshot(rebuiltPath, query), readTableSnapshot(incrementalPath, query), query);
      }

      // Verify query API parity across all major read surfaces (including PR #4754 reverse-trace reads)
      assert.deepEqual(rebuilt.readWorkspaceSummary(), incremental.readWorkspaceSummary());
      assert.deepEqual(rebuilt.listPinnedEntities("person-rebuild"), incremental.listPinnedEntities("person-rebuild"));
      assert.deepEqual(
        rebuilt.listDecisions({ modulePrefixes: ["packages/storage", "tools/gates"] }),
        incremental.listDecisions({ modulePrefixes: ["packages/storage", "tools/gates"] }),
      );
      assert.equal(rebuilt.listDecisions({ modulePrefixes: ["packages/storage"] }).decisions.length, 1);
      assert.deepEqual(
        rebuilt.searchFacts({ observedCommits: ["a".repeat(40)] }),
        incremental.searchFacts({ observedCommits: ["a".repeat(40)] }),
      );
      assert.deepEqual(
        rebuilt.searchFacts({ evidenceSourcePaths: ["packages/storage/src/projection/projection-tables.ts"] }),
        incremental.searchFacts({ evidenceSourcePaths: ["packages/storage/src/projection/projection-tables.ts"] }),
      );
      assert.deepEqual(
        rebuilt.readArtifactTimelinePage({ kind: "html", limit: 10 }),
        incremental.readArtifactTimelinePage({ kind: "html", limit: 10 }),
      );
      assert.deepEqual(
        rebuilt.readRuntimeDispatchByDispatchKey("dk-equiv-1"),
        incremental.readRuntimeDispatchByDispatchKey("dk-equiv-1"),
      );
      assert.deepEqual(
        rebuilt.readEventList({ nodeId: "node-edge-1", limit: 50 }),
        incremental.readEventList({ nodeId: "node-edge-1", limit: 50 }),
      );
      assert.deepEqual(
        rebuilt.readEventList({ entity: "task_alpha", limit: 50 }),
        incremental.readEventList({ entity: "task_alpha", limit: 50 }),
      );
      assert.deepEqual(
        rebuilt.readEventList({ actorPersonId: "person-rebuild", limit: 50 }),
        incremental.readEventList({ actorPersonId: "person-rebuild", limit: 50 }),
      );
      assert.deepEqual(rebuilt.readDocument(docPath), incremental.readDocument(docPath));
      assert.deepEqual(
        rebuilt.readDocumentHistory("facts/F-11223344.md"),
        incremental.readDocumentHistory("facts/F-11223344.md"),
      );

      // Verify triggers are fully restored after rebuild: applying one more event updates every derived table
      const followUp = makeDocEvent({
        revision: nextRev(),
        path: docPath,
        body: "# Report v3 after rebuild\n",
        baseSha: sha256Text(body2),
        baseLedgerSha: eventStore.currentCut(),
        occurredAt: at(40),
      });
      eventStore.append({ event: followUp.event, plan: docSyncWritePlan(followUp.event), blobs: followUp.blobs });
      incremental.apply(followUp.event, docSyncWritePlan(followUp.event));
      rebuilt.apply(followUp.event, docSyncWritePlan(followUp.event));
      assert.equal(rebuilt.readStateDigest(), incremental.readStateDigest());
      assert.deepEqual(
        readTableSnapshot(
          rebuiltPath,
          "SELECT workspace_revision, event_type, read_index_version FROM event_summary ORDER BY workspace_revision",
        ),
        readTableSnapshot(
          incrementalPath,
          "SELECT workspace_revision, event_type, read_index_version FROM event_summary ORDER BY workspace_revision",
        ),
      );
    } finally {
      incremental.close();
      rebuilt.close();
    }
  });
});

test("incremental DOCUMENT_BASE lookup uses covering metadata indexes without reading inline bodies", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventStore = makeTaskEventStore({ repoId: "doc-base-covering", rootDir });
    const projection = makeTaskProjection({ rootDir, eventStore });
    try {
      projection.readCut();
      const db = new DatabaseSync(projection.path);
      try {
        const activePlan = db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT json_extract(value_json, '$.blobSha256') AS blobSha256, json_extract(value_json, '$.size') AS size, json_extract(value_json, '$.mediaType') AS mediaType, json_extract(value_json, '$.policyId') AS policyId FROM document INDEXED BY document_metadata WHERE path = ?",
          )
          .all("context/sample.md") as readonly { readonly detail: string }[];
        assert.match(activePlan.map((row) => row.detail).join("\n"), /USING COVERING INDEX document_metadata/u);

        const historyPlan = db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT json_extract(value_json, '$.blobSha256') AS blobSha256, json_extract(value_json, '$.size') AS size, json_extract(value_json, '$.mediaType') AS mediaType, json_extract(value_json, '$.policyId') AS policyId FROM document_history INDEXED BY document_history_metadata WHERE path = ?",
          )
          .all("facts/F-11223344.md") as readonly { readonly detail: string }[];
        assert.match(
          historyPlan.map((row) => row.detail).join("\n"),
          /USING COVERING INDEX document_history_metadata/u,
        );

        db.prepare("INSERT INTO document(path, workspace_revision, value_json) VALUES (?, ?, ?)").run(
          "context/big.md",
          1,
          JSON.stringify({
            path: "context/big.md",
            blobSha256: "sha256:big",
            size: 1234,
            mediaType: "text/markdown",
            policyId: DECISION_DOCUMENT_POLICY_ID,
            body: "x".repeat(256_000),
            workspaceRevision: 1,
          }),
        );
        assert.deepEqual(
          { ...readDocumentBaseMetadata(db, "context/big.md") },
          {
            blobSha256: "sha256:big",
            size: 1234,
            mediaType: "text/markdown",
            policyId: DECISION_DOCUMENT_POLICY_ID,
          },
        );
      } finally {
        db.close();
      }
    } finally {
      projection.close();
    }
  });
});

test("createProjectionTables forwards onValidationProgress to backfillEventSummaryReadIndex", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE event_summary (
        workspace_revision INTEGER PRIMARY KEY,
        summary_json TEXT NOT NULL,
        witness_json TEXT NOT NULL,
        row_json TEXT NOT NULL
      )
    `);
    const insert = db.prepare("INSERT INTO event_summary VALUES (?, '{}', '{}', ?)");
    for (let revision = 1; revision <= 130; revision += 1) {
      insert.run(
        revision,
        JSON.stringify({
          revision,
          opId: `op-${revision}`,
          eventId: `event-${revision}`,
          schema: "task-event/v1",
          type: "task_created",
          occurredAt: "2026-11-22T00:00:00.000Z",
          actor: { personId: "person-a", executorId: null },
          entityRefs: [`task/task_${revision}`],
        }),
      );
    }
    const progress: Array<{ readonly applied: number; readonly total: number }> = [];
    createProjectionTables(db, (entry) => progress.push(entry));
    assert.deepEqual(progress, [
      { applied: 64, total: 130 },
      { applied: 128, total: 130 },
      { applied: 130, total: 130 },
    ]);
  } finally {
    db.close();
  }
});

test("optimized cold rebuild replays synthetic 5,000-event ledger with full indexes and compact page count", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    const template = lifecycleFixture().events[0]!;
    assert.equal(template.type, "task_created");
    const count = 5_000;
    const events: PersistedCanonicalEventV1[] = [];
    const blobs = new Map<string, Uint8Array>();
    const docLatestSha = new Map<string, string>();
    for (let revision = 1; revision <= count; revision += 1) {
      if (revision % 5 === 0) {
        const docPath = `context/doc-${revision % 200}.md`;
        const body = `# Doc ${revision}\n${"payload-".repeat(256)}\n`;
        const doc = makeDocEvent({
          revision,
          path: docPath,
          body,
          baseSha: docLatestSha.get(docPath) ?? null,
          occurredAt: new Date(Date.UTC(2026, 10, 22, 0, 0, revision)).toISOString(),
        });
        docLatestSha.set(docPath, doc.blobs[0]!.sha256);
        blobs.set(doc.blobs[0]!.sha256, doc.blobs[0]!.bytes);
        events.push(doc.event);
      } else {
        const taskId = `bench-task-${revision}`;
        events.push({
          ...template,
          eventId: `bench-ev-${revision}`,
          opId: `bench-op-${revision}`,
          taskId,
          workspaceRevision: revision,
          occurredAt: new Date(Date.UTC(2026, 10, 22, 0, 0, revision)).toISOString(),
          payload: { ...template.payload, task: { ...template.payload.task, taskId } },
        });
      }
    }
    const eventStore: EventStreamPort = {
      readHead: () => ({ revision: count, eventDigest: `sha256:${"c".repeat(64)}` }),
      readBatch: (cursor, maxItems) => {
        const start = cursor === null ? 0 : Number(cursor);
        const batch = events.slice(start, start + maxItems);
        const end = start + batch.length;
        return {
          sourceRevision: count,
          events: batch,
          cursor: end >= count ? null : String(end),
          done: end >= count,
          accessedItems: batch.length,
          prefetchContent: (replay) =>
            new Map(
              replay.flatMap((event) =>
                event.schema === "doc-event/v1"
                  ? event.payload.changes.flatMap((change) =>
                      change.candidate
                        ? [[change.candidate.sha256, blobs.get(change.candidate.sha256) ?? null] as const]
                        : [],
                    )
                  : [],
              ),
            ),
        };
      },
      readContentBlob: (sha256) => blobs.get(sha256) ?? null,
    };
    const projection = makeTaskProjection({ rootDir, eventStore });
    try {
      const startedAt = performance.now();
      const receipt = projection.rebuild();
      const elapsedMs = Math.round(performance.now() - startedAt);
      assert.equal(receipt.watermark, count);
      const db = new DatabaseSync(projection.path, { readOnly: true });
      try {
        const pageCount = Number((db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count);
        const triggerCount = Number(
          (db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger'").get() as { count: number })
            .count,
        );
        const indexCount = Number(
          (db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index'").get() as { count: number })
            .count,
        );
        assert.ok(triggerCount >= 35, `expected restored triggers, got ${triggerCount}`);
        assert.ok(indexCount >= 90, `expected restored indexes, got ${indexCount}`);
        t.diagnostic(
          `cold-rebuild-5k-benchmark=${JSON.stringify({ events: count, elapsedMs, pageCount, triggerCount, indexCount })}`,
        );
      } finally {
        db.close();
      }
    } finally {
      projection.close();
    }
  });
});

test("cold open after rebuild keeps ensureRuntimeMemberIndex indexed and adopts the finalized connection", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    const template = lifecycleFixture().events[0]!;
    assert.equal(template.type, "task_created");
    const count = 200;
    const events: PersistedCanonicalEventV1[] = Array.from({ length: count }, (_, index) => {
      const revision = index + 1;
      const taskId = `cold-open-task-${revision}`;
      return {
        ...template,
        eventId: `cold-open-ev-${revision}`,
        opId: `cold-open-op-${revision}`,
        taskId,
        workspaceRevision: revision,
        occurredAt: new Date(Date.UTC(2026, 10, 22, 1, 0, revision)).toISOString(),
        payload: { ...template.payload, task: { ...template.payload.task, taskId } },
      };
    });
    const readHead = () => ({ revision: count, eventDigest: `sha256:${"d".repeat(64)}` as const });
    const eventStore: EventStreamPort = {
      readHead,
      readBatch: (cursor, maxItems) => {
        const start = cursor === null ? 0 : Number(cursor);
        const batch = events.slice(start, start + maxItems);
        const end = start + batch.length;
        return {
          sourceRevision: count,
          events: batch,
          cursor: end >= count ? null : String(end),
          done: end >= count,
          accessedItems: batch.length,
          prefetchContent: () => new Map(),
        };
      },
      readContentBlob: () => null,
    };
    const projection = makeTaskProjection({ rootDir, eventStore });
    try {
      assert.equal(projection.rebuild().watermark, count);
      // Same owner must reuse the finalized WAL connection without re-running createTables DDL.
      const observedSql: string[] = [];
      const originalExec = DatabaseSync.prototype.exec;
      const execGuard = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
        observedSql.push(sql);
        return Reflect.apply(originalExec, this, [sql]);
      });
      let adoptedHandle: DatabaseSync | null = null;
      try {
        assert.equal(projection.list({ limit: 1 }).rows.length, 1);
        withDatabase(projection.path, readHead, (db) => {
          adoptedHandle = db;
        });
      } finally {
        execGuard.mock.restore();
      }
      assert.equal(
        observedSql.some((sql) => /CREATE TABLE/u.test(sql)),
        false,
        "first read after rebuild should reuse the adopted finalized connection without re-running createTables",
      );
      assert.notEqual(adoptedHandle, null);
      projection.close();
      assert.throws(() => adoptedHandle!.exec("SELECT 1"), "projection.close() must close the adopted rebuild handle");

      // Cold reopen (fresh connection running ensureRuntimeMemberIndex) must use partial indexes, never scan event_index.
      const db = new DatabaseSync(projection.path);
      const plans: Array<{ readonly sql: string; readonly plan: readonly { readonly detail: string }[] }> = [];
      const originalPrepare = DatabaseSync.prototype.prepare;
      const prepareGuard = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
        if (!/FROM event_index/u.test(sql)) return Reflect.apply(originalPrepare, this, [sql]);
        const plan = Reflect.apply(originalPrepare, this, [`EXPLAIN QUERY PLAN ${sql}`]);
        const statement = Reflect.apply(originalPrepare, this, [sql]);
        return new Proxy(statement, {
          get(target, key) {
            if (key === "all")
              return (...values: unknown[]) => {
                plans.push({
                  sql,
                  plan: Reflect.apply(plan.all, plan, values) as readonly { readonly detail: string }[],
                });
                return Reflect.apply(target.all, target, values);
              };
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });
      try {
        ensureRuntimeMemberIndex(db, () => assert.fail("freshly rebuilt DB must have zero pending runtime rows"));
      } finally {
        prepareGuard.mock.restore();
        db.close();
      }
      assert.ok(plans.length >= 1, "expected ensureRuntimeMemberIndex to probe event_index");
      for (const entry of plans) {
        assert.ok(
          entry.plan.every(
            ({ detail }) =>
              !/\bSCAN event_index\b/u.test(detail) ||
              /USING INDEX event_index_runtime_(?:member|dispatch_key)_pending/u.test(detail),
          ),
          `ensureRuntimeMemberIndex performed a full scan of event_index: ${JSON.stringify(entry)}`,
        );
      }
    } finally {
      projection.close();
    }
  });
});
