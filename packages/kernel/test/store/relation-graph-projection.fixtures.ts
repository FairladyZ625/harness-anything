import type { FactEventDraftV1 } from "../../src/domain/fact-event.ts";
import type { DecisionEventDraftV1 } from "../../src/domain/decision-event-types.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  MIGRATION_DOCUMENT_POLICY_ID,
  REPLAY_TASK_GRAPH,
  compileDecisionWrite,
  compileFactWrite,
  deriveRelationId,
  formatRelationFlowRecord,
  makeTaskProjection,
  serializeCanonicalEvent,
  sha256Text,
  type EntityRelationRecord,
  type MigrationImportEventV1,
  type TaskEventV1,
} from "../../src/index.ts";
import { createDecisionProjectionTables } from "../../src/projection/decision-event-projection.ts";
import { createFactProjectionTables } from "../../src/projection/fact-event-projection.ts";
import { createRelationGraphProjectionTables } from "../../src/projection/relation-graph-projection.ts";
import { realizedDecisionBody } from "../../../../tools/fixtures/task-plan.mjs";

export const actor = {
  principal: { personId: "proposer" },
  executor: null,
} as const;

export function proposal(revision: number, decisionId: string): DecisionEventDraftV1 {
  return {
    schema: "decision-event/v1",
    eventId: `event-${revision}`,
    workspaceRevision: revision,
    opId: `op-${revision}`,
    decisionId,
    type: "decision_proposed",
    actor,
    source: "local",
    occurredAt: "2026-08-13T00:00:00.000Z",
    payload: {
      title: "Canonical Decision",
      question: "Is this event-backed?",
      riskTier: "medium",
      urgency: "medium",
      vertical: "test",
      preset: "default",
      appliesTo: { modules: ["kernel"], productLines: [] },
      decisionClass: "ordinary",
      chosen: [{ id: "CH1", text: "Use events" }],
      rejected: [{ id: "RJ1", text: "Use files", whyNot: "Files are not canonical." }],
      body: realizedDecisionBody("Canonical Decision"),
      claims: [],
      fulfillments: [],
      relations: [],
    },
  };
}
export function claim(revision: number, decisionId: string): DecisionEventDraftV1 {
  return {
    schema: "decision-event/v1",
    eventId: `event-${revision}`,
    workspaceRevision: revision,
    opId: `op-${revision}`,
    decisionId,
    type: "decision_claim_declared",
    actor,
    source: "local",
    occurredAt: "2026-08-13T00:00:00.000Z",
    payload: {
      claimId: "C1",
      text: "The relation truth is shared.",
      loadBearing: true,
    },
  };
}
export function accepted(revision: number, decisionId: string): DecisionEventDraftV1 {
  return {
    schema: "decision-event/v1",
    eventId: `event-${revision}`,
    workspaceRevision: revision,
    opId: `op-${revision}`,
    decisionId,
    type: "decision_accepted",
    actor: { principal: { personId: "arbiter" }, executor: null },
    source: "local",
    occurredAt: "2026-08-13T00:00:01.000Z",
    payload: {
      rationale: "Independent approval.",
      judgmentOnlyRationale: "Explicit judgment-only approval.",
    },
  };
}
export function related(revision: number, decisionId: string, record: EntityRelationRecord): DecisionEventDraftV1 {
  return {
    schema: "decision-event/v1",
    eventId: `event-${revision}`,
    workspaceRevision: revision,
    opId: `op-${revision}`,
    decisionId,
    type: "decision_related",
    actor,
    source: "local",
    occurredAt: "2026-08-13T00:00:00.000Z",
    payload: { relation: record },
  };
}
export function fact(revision: number): FactEventDraftV1 {
  return {
    schema: "fact-event/v1",
    eventId: `event-${revision}`,
    workspaceRevision: revision,
    opId: `op-${revision}`,
    taskId: "task-evidence",
    factId: "F-DEADBEEF",
    type: "fact_recorded",
    actor,
    source: "local",
    occurredAt: "2026-08-13T00:00:00.000Z",
    payload: {
      statement: "Event-backed evidence",
      evidenceSource: "test",
      observedAt: "2026-08-13T00:00:00.000Z",
      confidence: "high",
      memoryClass: "semantic",
      memoryTags: [],
      provenance: [
        {
          runtime: "unavailable",
          sessionId: null,
          transcriptReachability: "unavailable",
          boundAt: "2026-08-13T00:00:00.000Z",
        },
      ],
    },
  };
}
export function taskCreated(revision: number, taskId: string): TaskEventV1 {
  return {
    schema: "task-event/v1",
    eventId: `event-${revision}`,
    workspaceRevision: revision,
    opId: `op-${revision}`,
    taskId,
    type: "task_created",
    actor,
    source: "local",
    occurredAt: "2026-08-13T00:00:00.000Z",
    payload: {
      task: {
        schema: "task/v1",
        taskId,
        title: "Cycle task",
        taskClass: "standard",
        status: "planned",
        graph: REPLAY_TASK_GRAPH,
        currentNode: "implementation",
        iteration: 0,
        createdBy: actor,
        completionGateIds: [],
        presetSnapshotDigest: null,
      },
    },
  };
}
export function relation(input: Pick<EntityRelationRecord, "source" | "target" | "type">): EntityRelationRecord {
  const identity = { ...input, direction: "directed" as const };
  return {
    relation_id: deriveRelationId(identity),
    ...identity,
    strength: "strong",
    origin: "declared",
    rationale: "Production entry fixture.",
    state: "active",
  };
}
export function migrationFactEvent(revision: number): MigrationImportEventV1 {
  const body = "# Facts\n",
    opId = `migration-fact-${revision}`;
  return {
    schema: "migration-import-event/v1",
    eventId: `event-${opId}`,
    workspaceRevision: revision,
    opId,
    type: "entity_migrated",
    actor,
    source: "migration-import/v1",
    occurredAt: "2026-08-15T00:00:00.000Z",
    payload: {
      migratedFrom: "legacy-fact",
      generation: "v0",
      entity: {
        kind: "fact",
        fact: {
          taskId: "task-cold",
          factId: "F-3VSTHPDM",
          statement: "Migrated event fact",
          evidenceSource: "fixture",
          observedAt: "2026-08-14T00:00:00.000Z",
          confidence: "high",
          memoryClass: "episodic",
          memoryTags: [],
          provenance: [
            {
              runtime: "human",
              sessionId: "migration",
              boundAt: "2026-08-15T00:00:00.000Z",
            },
          ],
        },
        documentClaim: {
          path: "tasks/task-cold-fixture/facts.md",
          sha256: sha256Text(body),
          size: Buffer.byteLength(body),
          mediaType: "text/markdown",
          policyId: MIGRATION_DOCUMENT_POLICY_ID,
        },
      },
    },
  };
}
export function migrationRelationEvent(revision: number, record: EntityRelationRecord): MigrationImportEventV1 {
  const opId = `migration-relation-${revision}`;
  return {
    schema: "migration-import-event/v1",
    eventId: `event-${opId}`,
    workspaceRevision: revision,
    opId,
    type: "entity_migrated",
    actor,
    source: "migration-import/v1",
    occurredAt: "2026-08-15T00:00:01.000Z",
    payload: {
      migratedFrom: record.relation_id,
      generation: "v0",
      entity: {
        kind: "relation",
        relation: { ...record, origin: "imported_snapshot" },
        ownerRef: "decision/dec_COLD",
      },
    },
  };
}
export function writeMigrationEvent(rootDir: string, event: MigrationImportEventV1): void {
  const eventRoot = path.join(rootDir, "harness/events/fixture");
  mkdirSync(eventRoot, { recursive: true });
  writeFileSync(path.join(eventRoot, `${event.opId}.json`), serializeCanonicalEvent(event));
}
export function writeFactEvent(rootDir: string, event: FactEventDraftV1): void {
  const compiled = compileFactWrite({
      event,
    }),
    eventRoot = path.join(rootDir, "harness/events/fixture");
  mkdirSync(eventRoot, { recursive: true });
  writeFileSync(path.join(eventRoot, `${event.opId}.json`), serializeCanonicalEvent(compiled.event));
}
export function writeLegacyFactEvent(rootDir: string, event: FactEventDraftV1): void {
  const compiled = compileFactWrite({ event }),
    legacy = {
      ...compiled.event,
      payload: {
        ...compiled.event.payload,
        factsDocumentClaim: {
          ...compiled.event.payload.factsDocumentClaim,
          path: `tasks/${event.taskId}-fixture/facts.md`,
        },
      },
    },
    eventRoot = path.join(rootDir, "harness/events/fixture");
  mkdirSync(eventRoot, { recursive: true });
  writeFileSync(path.join(eventRoot, `${event.opId}.json`), `${JSON.stringify(legacy)}\n`);
}
export function projectionFixture(rootDir: string) {
  const blobs = new Map<string, Uint8Array>(),
    eventStore = {
      readHead: () => null,
      readBatch: () => ({
        sourceRevision: 0,
        events: [],
        cursor: null,
        done: true,
        accessedItems: 0,
      }),
      readContentBlob: (sha256: string) => blobs.get(sha256) ?? null,
    };
  return { blobs, projection: makeTaskProjection({ rootDir, eventStore }) };
}
export function decisionProjectionDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE projection_meta (singleton INTEGER PRIMARY KEY, watermark INTEGER NOT NULL); INSERT INTO projection_meta VALUES (1, 1); CREATE TABLE document (path TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL, value_json TEXT NOT NULL); CREATE TABLE task_snapshot (task_id TEXT PRIMARY KEY, workspace_revision INTEGER NOT NULL, snapshot_json TEXT NOT NULL)",
  );
  createRelationGraphProjectionTables(db);
  createFactProjectionTables(db);
  createDecisionProjectionTables(db);
  return db;
}
export function compileCurrent(fixture: ReturnType<typeof projectionFixture>, event: DecisionEventDraftV1) {
  const { projection } = fixture,
    current = projection.readDecision(event.decisionId).decision,
    path = `decisions/decision-${event.decisionId}/decision.md`,
    document = projection.readDocument(path).document,
    relations = projection
      .readDecisionGraph()
      .edges.filter((edge) => edge.ownerRef === `decision/${event.decisionId}`)
      .map((edge) => ({
        relation_id: edge.relationId,
        source: edge.sourceRef,
        target: edge.targetRef,
        type: edge.relationType,
        strength: edge.strength,
        direction: edge.direction,
        origin: edge.origin,
        rationale: edge.rationale,
        state: edge.state,
      }));
  return compileDecisionWrite({
    event,
    currentDecision: current,
    currentRelations: relations,
    currentDocument: document,
  });
}
export function applyDecision(fixture: ReturnType<typeof projectionFixture>, event: DecisionEventDraftV1): void {
  const compiled = compileCurrent(fixture, event);
  fixture.blobs.set(compiled.blobs[0].sha256, Buffer.from(compiled.body));
  fixture.projection.apply(compiled.event, compiled.plan);
}
export function applyFact(fixture: ReturnType<typeof projectionFixture>, event: FactEventDraftV1): void {
  const compiled = compileFactWrite({
    event,
    packagePath: `tasks/${event.taskId}-evidence`,
    currentFacts: fixture.projection.searchFacts({ taskId: event.taskId }).facts,
  });
  fixture.blobs.set(compiled.blobs[0].sha256, Buffer.from(compiled.body));
  fixture.projection.apply(compiled.event, compiled.plan);
}
export function writeTask(rootDir: string, taskId: string, record: EntityRelationRecord): void {
  const taskRoot = path.join(rootDir, "harness/tasks", taskId);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(
    path.join(taskRoot, "INDEX.md"),
    [
      "---",
      "schema: task-package/v2",
      `task_id: ${taskId}`,
      `title: ${taskId}`,
      "lifecycle:",
      "  engine: local",
      "  status: active",
      "packageDisposition: active",
      "vertical: default",
      "preset: default",
      "relations:",
      formatRelationFlowRecord(record),
      "---",
      "",
      `# ${taskId}`,
      "",
    ].join("\n"),
  );
}
export function seedRelationProjection(projectionPath: string, includeTruthSource = true): void {
  mkdirSync(path.dirname(projectionPath), { recursive: true });
  const db = new DatabaseSync(projectionPath);
  try {
    db.exec(`
  CREATE TABLE projection_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE task_projection (task_id TEXT PRIMARY KEY,title TEXT NOT NULL,parent_task_id TEXT,canonical_status TEXT NOT NULL,coordination_status TEXT NOT NULL,raw_status TEXT NOT NULL,package_disposition TEXT NOT NULL,closeout_readiness TEXT NOT NULL,lifecycle_engine TEXT NOT NULL,freshness TEXT NOT NULL,updated_at TEXT NOT NULL,source TEXT NOT NULL,source_path TEXT NOT NULL,work_kind TEXT,risk_tier TEXT,urgency TEXT,vertical TEXT,preset TEXT,profile TEXT,module_key TEXT,module_title TEXT,has_lesson_candidates INTEGER NOT NULL);
  CREATE TABLE relation_edges (relation_id TEXT PRIMARY KEY,source_ref TEXT NOT NULL,target_ref TEXT NOT NULL,relation_type TEXT NOT NULL,direction TEXT NOT NULL,strength TEXT NOT NULL,origin TEXT NOT NULL,state TEXT NOT NULL,rationale TEXT NOT NULL,owner_ref TEXT NOT NULL,source_path TEXT NOT NULL,record_index INTEGER NOT NULL);
  CREATE TABLE relation_coverage (claim_ref TEXT PRIMARY KEY,decision_ref TEXT NOT NULL,status TEXT NOT NULL,fulfillment TEXT NOT NULL,covering_fact_ref TEXT,refuting_fact_refs_json TEXT,relation_path_json TEXT NOT NULL);
  CREATE TABLE task_fact_anchors (fact_ref TEXT PRIMARY KEY,task_id TEXT NOT NULL,fact_id TEXT NOT NULL,source_path TEXT NOT NULL);
  CREATE TABLE task_fact_projection (fact_ref TEXT PRIMARY KEY,task_id TEXT NOT NULL,fact_id TEXT NOT NULL,schema_name TEXT NOT NULL,statement TEXT NOT NULL,source TEXT NOT NULL,observed_at TEXT NOT NULL,confidence TEXT NOT NULL,memory_class TEXT NOT NULL,memory_tags_json TEXT NOT NULL,provenance_json TEXT NOT NULL,liveness TEXT NOT NULL);
  INSERT INTO task_projection VALUES ('task-positive','Positive',NULL,'active','open','active','active','not_ready','kernel/task-lifecycle/v1','fresh','2026-08-14T00:00:00.000Z','local-document','harness/tasks/task-positive/INDEX.md',NULL,'medium','medium','software/coding','standard-task',NULL,'kernel','Kernel',0);
  INSERT INTO relation_edges VALUES ('rel_positive','decision/dec_01KXA7811SVVT8P66HNDFZQ7DF/CH1','task/task-positive','derives','directed','strong','declared','active','positive','decision/dec_01KXA7811SVVT8P66HNDFZQ7DF','harness/decisions/decision-dec_01KXA7811SVVT8P66HNDFZQ7DF/decision.md',0);
  INSERT INTO relation_coverage VALUES ('decision/dec_01KXA7811SVVT8P66HNDFZQ7DF/CH1','decision/dec_01KXA7811SVVT8P66HNDFZQ7DF','covered','standing-policy',NULL,'[]','["rel_positive"]');
  INSERT INTO task_fact_anchors VALUES ('fact/F-POSITIVE','task-positive','F-POSITIVE','harness/facts/F-POSITIVE.md');
  INSERT INTO task_fact_projection VALUES ('fact/F-POSITIVE','task-positive','F-POSITIVE','task-fact-row/v1','Observed','fixture','2026-08-14T00:00:00.000Z','high','semantic','[]','[]','standing');`);
    if (includeTruthSource) db.exec("INSERT INTO projection_meta VALUES ('relationTruthSource','authored-l1/v1')");
  } finally {
    db.close();
  }
}
export function writeColdHistory(
  rootDir: string,
  evidenced: EntityRelationRecord,
  derived: EntityRelationRecord,
  superseded: EntityRelationRecord,
): void {
  const taskRoot = path.join(rootDir, "harness/tasks/task-cold"),
    decisionRoot = path.join(rootDir, "harness/decisions/decision-dec_COLD");
  mkdirSync(taskRoot, { recursive: true });
  mkdirSync(decisionRoot, { recursive: true });
  writeFileSync(
    path.join(taskRoot, "INDEX.md"),
    [
      "---",
      "schema: task-package/v2",
      "task_id: task-cold",
      "title: Cold task",
      "lifecycle:",
      "  engine: local",
      "  status: active",
      "packageDisposition: active",
      "vertical: default",
      "preset: default",
      "---",
      "",
      "# Cold task",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(taskRoot, "facts.md"),
    [
      "# Facts",
      "",
      "## Records",
      "",
      '- {fact_id: F-DEADBEEF, statement: "Cold rebuild evidence", source: "fixture", observedAt: "2026-07-01T00:00:00.000Z", confidence: high, memoryClass: semantic, memoryTags: [episode], provenance: [{runtime: "human", sessionId: "cold", boundAt: "2026-07-01T00:00:00.000Z"}]}',
      '- {fact_id: F-ABCDEFGH, statement: "Migrated historical endpoint", source: "fixture", observedAt: "2026-07-01T00:00:00.000Z", confidence: high, memoryClass: semantic, memoryTags: [], provenance: [{runtime: "human", sessionId: "cold", boundAt: "2026-07-01T00:00:00.000Z"}], migration: {schema: "fact-migration/v1", state: migrated, plan_id: "plan", execution_ref: "execution/exe", evidence_id: "evidence", migrated_at: "2026-07-02T00:00:00.000Z"}}',
      "relations:",
      formatRelationFlowRecord(superseded),
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(decisionRoot, "decision.md"),
    [
      "---",
      "schema: decision-package/v1",
      "decision_id: dec_COLD",
      "_coordinatorWatermark: cold-unique",
      'title: "Cold truth"',
      "state: active",
      "riskTier: medium",
      "urgency: medium",
      'vertical: "software/coding"',
      'preset: "architecture-decision"',
      "applies_to:",
      "  modules: []",
      "  productLines: []",
      'proposedAt: "2026-07-01T00:00:00.000Z"',
      'decidedAt: "2026-07-01T00:01:00.000Z"',
      "provenance:",
      '  - { runtime: "human", sessionId: "cold", boundAt: "2026-07-01T00:00:00.000Z" }',
      'question: "Can authored truth rebuild?"',
      "chosen:",
      '  - { id: "CH1", text: "Yes" }',
      "rejected:",
      '  - { id: "RJ1", text: "No", why_not: "Loses truth" }',
      "claims:",
      '  - { id: "C1", text: "Authored truth rebuilds", fulfillment: "evidenced" }',
      "relations:",
      formatRelationFlowRecord(evidenced),
      formatRelationFlowRecord(derived),
      "---",
      "",
      "# Cold truth",
      "",
    ].join("\n"),
  );
}
export function git(rootDir: string, ...argsAndMaybeEnv: Array<string | Record<string, string>>): string {
  const maybeEnv = argsAndMaybeEnv.at(-1),
    env = typeof maybeEnv === "object" ? maybeEnv : {},
    args = argsAndMaybeEnv.filter((value): value is string => typeof value === "string");
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    env: { ...process.env, ...env },
  }).trim();
}
export function testReadinessSource() {
  return {
    run: (rootDir: string, args: readonly string[], allowNoMatch = false) => {
      try {
        return { ok: true, stdout: git(rootDir, ...args) };
      } catch (error) {
        const status = typeof error === "object" && error && "status" in error ? Number(error.status) : null;
        return { ok: allowNoMatch && status === 1, stdout: "" };
      }
    },
  };
}
