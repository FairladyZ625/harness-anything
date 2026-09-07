// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  MIGRATION_DOCUMENT_POLICY_ID,
  REPLAY_TASK_GRAPH,
  sha256Text,
  validateCurrentCanonicalEvent,
  validateTaskV2,
  type CanonicalEventV1,
  type TaskV2,
} from "../../src/index.ts";
import { OPAQUE_TEXTUAL_POLICY_ID } from "../../src/domain/artifact-text-classification.ts";
import { DECISION_DOCUMENT_POLICY_ID } from "../../src/domain/decision-event-types.ts";
import { eventShapeMigrations, type EventShapeCut } from "../../src/store/event-shape-migration.ts";

const actor = { principal: { personId: "person_synthetic" }, executor: null } as const,
  snapshotDigest = `sha256:${"b".repeat(64)}` as const,
  claim = {
    path: "tasks/task_synthetic-synthetic/INDEX.md",
    sha256: "a".repeat(64),
    size: 1,
    mediaType: "text/markdown" as const,
    policyId: MIGRATION_DOCUMENT_POLICY_ID,
  },
  currentMetadata = {
    idempotencyKey: null,
    parentTaskId: null,
    workKind: null,
    riskTier: null,
    urgency: null,
    verticalId: "software/coding",
    presetId: "create-milestone",
    profileId: "baseline",
    moduleKey: null,
    slug: "synthetic",
    surfaces: [],
    fromLegacyId: null,
  } as const;

test("legacy import normalization rewrites all three persisted event classes to current shape", () => {
  const direct = taskBootstrapEvent(false),
    directRewrite = migration().rewrite(direct, cut());
  assert.deepEqual(validateCurrentCanonicalEvent(direct), ["Task/v2 fields are incomplete or unknown"]);
  assert.ok(directRewrite);
  assert.equal((directRewrite.event.payload.task as TaskV2).pinned, false);
  assert.deepEqual(validateCurrentCanonicalEvent(directRewrite.event), []);

  const importedTask = migrationTaskEvent(),
    legacyTask = importedTask.payload.entity.task;
  assert.deepEqual(validateTaskV2(legacyTask), [
    {
      code: "invalid_task",
      message: "task metadata is missing required fields: workKind, urgency, verticalId, surfaces",
    },
  ]);
  assert.deepEqual(validateCurrentCanonicalEvent(importedTask), ["migration task entity is invalid"]);
  const taskRewrite = migration().rewrite(importedTask, cut());
  assert.ok(taskRewrite);
  assert.deepEqual(taskRewrite.event.payload.entity.task.metadata, currentMetadata);
  assert.deepEqual(validateCurrentCanonicalEvent(taskRewrite.event), []);

  const importedDecision = migrationDecisionEvent(),
    originalIdentity = { eventId: importedDecision.eventId, opId: importedDecision.opId };
  assert.deepEqual(validateCurrentCanonicalEvent(importedDecision), ["migration import event identity is invalid"]);
  const decisionRewrite = migration().rewrite(importedDecision, cut());
  assert.ok(decisionRewrite);
  assert.deepEqual({ eventId: decisionRewrite.event.eventId, opId: decisionRewrite.event.opId }, originalIdentity);
  assert.equal(decisionRewrite.event.occurredAt, "2026-06-02T16:00:00.000Z");
  assert.equal(Date.parse(decisionRewrite.event.occurredAt), Date.parse(importedDecision.occurredAt));
  assert.deepEqual(validateCurrentCanonicalEvent(decisionRewrite.event), []);
});

test("legacy import normalization is idempotent and converges with task snapshot normalization", () => {
  const currentImport = migrationTaskEvent(currentMetadata);
  assert.equal(migration().rewrite(currentImport, cut()), null);

  let event = taskBootstrapEvent(false, []),
    rewrites = 0;
  for (let round = 0; round < 3; round += 1) {
    let changed = false;
    for (const family of Object.values(eventShapeMigrations)) {
      const rewrite = family.rewrite(event, cut());
      if (rewrite === null) continue;
      event = rewrite.event;
      rewrites += 1;
      changed = true;
    }
    if (!changed) break;
  }
  assert.equal(rewrites, 2);
  assert.equal(Object.hasOwn(event.payload.task, "relations"), false);
  assert.equal(event.payload.task.pinned, false);
  assert.deepEqual(validateCurrentCanonicalEvent(event), []);
  assert.equal(
    Object.values(eventShapeMigrations).every((family) => family.rewrite(event, cut()) === null),
    true,
  );
});

test("legacy import normalization covers every inventory shape", () => {
  const taskEvent = {
      ...taskBootstrapEvent(true),
      schema: "task-event/v1",
      type: "execution_started",
      payload: { task: legacyTaskWithProvenance() },
    } as CanonicalEventV1,
    taskRewrite = migration().rewrite(taskEvent, cut());
  assert.ok(taskRewrite);
  assert.equal(taskRewrite.event.payload.task.schema, "task/v2");
  assert.equal(taskRewrite.event.payload.task.pinned, false);
  assert.equal(taskRewrite.event.payload.task.provenance[0].transcriptReachability, "by_session_id");

  const factEvent = migrationFactEvent(),
    factRewrite = migration().rewrite(factEvent, cut());
  assert.deepEqual(validateCurrentCanonicalEvent(factEvent), ["migration fact entity is invalid"]);
  assert.ok(factRewrite);
  assert.equal(factRewrite.event.payload.entity.fact.observedAt, "2026-08-01T12:25:14.000Z");
  assert.equal(factRewrite.event.payload.entity.fact.provenance[0].boundAt, "2026-08-01T12:25:14.000Z");
  assert.deepEqual(validateCurrentCanonicalEvent(factRewrite.event), []);

  const decisionEvent = migrationDecisionEventWithLegacyDecisionTimestamp(),
    decisionRewrite = migration().rewrite(decisionEvent, cut());
  assert.deepEqual(validateCurrentCanonicalEvent(decisionEvent), ["migration decision entity is invalid"]);
  assert.ok(decisionRewrite);
  assert.equal(decisionRewrite.event.payload.entity.decision.decidedAt, "2026-06-02T16:00:00.000Z");
  assert.deepEqual(validateCurrentCanonicalEvent(decisionRewrite.event), []);

  const proposal = legacyDecisionProposal(),
    proposalRewrite = migration().rewrite(proposal, cut());
  assert.ok(proposalRewrite);
  assert.equal(Object.keys(proposalRewrite.event.payload).length, 17);
  assert.deepEqual(validateCurrentCanonicalEvent(proposalRewrite.event), []);

  const doc = legacyDocEvent(),
    docRewrite = migration().rewrite(doc, cut(taskBootstrapEvent(true)));
  assert.ok(docRewrite);
  assert.equal(docRewrite.event.source, "local");
  assert.deepEqual(Object.keys(docRewrite.event.payload.baseLedgerSha).sort(), ["headDigest", "repoId", "revision"]);
  assert.deepEqual(validateCurrentCanonicalEvent(docRewrite.event), []);
});

function migration() {
  return eventShapeMigrations["legacy-import-normalization-migrate"];
}

function cut(headEvent: CanonicalEventV1 | null = null): EventShapeCut {
  return {
    readEntityVersionWitness: () => ({ currentVersion: null, observedRevision: 0 }),
    readDecisionDocumentState: () => null,
    readReplicaBasis: () => ({
      watermark: headEvent?.workspaceRevision ?? 0,
      sourceRevision: headEvent?.workspaceRevision ?? 0,
      headEvent,
      events: [],
      documents: [],
    }),
  };
}

function task(pinned = true, metadata: Readonly<Record<string, unknown>> | undefined = undefined): TaskV2 {
  return {
    schema: "task/v2",
    taskId: "task_synthetic",
    title: "Synthetic task",
    taskClass: "standard",
    status: "planned",
    graph: REPLAY_TASK_GRAPH,
    currentNode: "implementation",
    iteration: 0,
    createdBy: actor,
    completionGateIds: [],
    presetSnapshotDigest: snapshotDigest,
    pinned,
    ...(metadata === undefined ? {} : { metadata }),
  } as TaskV2;
}

function taskBootstrapEvent(pinned: boolean, relations?: readonly unknown[]): CanonicalEventV1 {
  const embedded = task(pinned) as TaskV2 & { pinned?: boolean; relations?: readonly unknown[] };
  if (!pinned) delete embedded.pinned;
  if (relations !== undefined) embedded.relations = relations;
  return {
    schema: "task-bootstrap-event/v1",
    eventId: "event-bootstrap-synthetic",
    workspaceRevision: 1,
    opId: "op-bootstrap-synthetic",
    taskId: embedded.taskId,
    type: "task_bootstrapped",
    actor,
    source: "local",
    occurredAt: "2026-08-13T00:00:00.000Z",
    payload: {
      task: embedded,
      presetSnapshotClaim: {
        digest: snapshotDigest,
        sha256: "c".repeat(64),
        size: 1,
        mediaType: "application/json",
      },
      initialDocumentClaims: [
        {
          path: "tasks/task_synthetic-synthetic/task_plan.md",
          sha256: "d".repeat(64),
          size: 1,
          mediaType: "text/markdown",
          owner: "doc-sync",
          policyId: "markdown-body-replaceable/v1",
        },
      ],
    },
  } as CanonicalEventV1;
}

function migrationTaskEvent(metadata: Readonly<Record<string, unknown>> = legacyMetadata()): CanonicalEventV1 & {
  readonly payload: { readonly entity: { readonly task: TaskV2 } };
} {
  const opId = "migration-task-synthetic";
  return {
    schema: "migration-import-event/v1",
    eventId: `event-${sha256Text(opId)}`,
    workspaceRevision: 1,
    opId,
    type: "entity_migrated",
    actor,
    source: "migration-import/v1",
    occurredAt: "2026-06-03T00:00:00.000Z",
    payload: {
      migratedFrom: "task_synthetic",
      generation: "v0",
      entity: {
        kind: "task",
        provenance: "imported_snapshot",
        task: task(true, metadata),
        originalStatus: "planned",
        packagePath: "tasks/task_synthetic-synthetic",
        documentClaim: claim,
      },
    },
  } as CanonicalEventV1 & { readonly payload: { readonly entity: { readonly task: TaskV2 } } };
}

function legacyMetadata() {
  const {
    workKind: _workKind,
    urgency: _urgency,
    verticalId: _verticalId,
    surfaces: _surfaces,
    ...legacy
  } = currentMetadata;
  return { ...legacy, longRunning: false };
}

function migrationDecisionEvent(): CanonicalEventV1 {
  const opId = "migration-decision-synthetic",
    decisionId = "dec_SYNTHETIC";
  return {
    schema: "migration-import-event/v1",
    eventId: `event-${sha256Text(opId)}`,
    workspaceRevision: 2,
    opId,
    type: "entity_migrated",
    actor,
    source: "migration-import/v1",
    occurredAt: "2026-06-03T00:00:00+08:00",
    payload: {
      migratedFrom: decisionId,
      generation: "v0",
      entity: {
        kind: "decision",
        decision: {
          decisionId,
          state: "in_effect",
          title: "Synthetic decision",
          proposedAt: "2026-06-02T15:00:00.000Z",
          decidedAt: "2026-06-02T16:00:00.000Z",
          chosen: [],
          rejected: [],
          claims: [],
          relations: [],
          judgmentConsents: [],
        },
        documentClaim: {
          ...claim,
          path: `decisions/decision-${decisionId}/decision.md`,
        },
      },
    },
  } as CanonicalEventV1;
}

function legacyTaskWithProvenance(): TaskV2 {
  const value = task(true, legacyMetadata()) as TaskV2 & { schema: string; pinned?: boolean };
  value.schema = "task/v1";
  delete value.pinned;
  return {
    ...value,
    provenance: [{ runtime: "codex", sessionId: "session-synthetic", boundAt: "2026-08-01T00:00:00.000Z" }],
  } as TaskV2;
}

function migrationFactEvent(): CanonicalEventV1 {
  const opId = "migration-fact-synthetic";
  return {
    schema: "migration-import-event/v1",
    eventId: `event-${sha256Text(opId)}`,
    workspaceRevision: 3,
    opId,
    type: "entity_migrated",
    actor,
    source: "migration-import/v1",
    occurredAt: "2026-08-01T12:25:14.000Z",
    payload: {
      migratedFrom: "F-ABCDEFGH",
      generation: "v0",
      entity: {
        kind: "fact",
        fact: {
          factId: "F-ABCDEFGH",
          statement: "Synthetic fact",
          evidenceSource: "synthetic",
          observedAt: "2026-08-01T20:25:14+08:00",
          confidence: "high",
          memoryClass: "episodic",
          memoryTags: [],
          provenance: [{ runtime: "codex", sessionId: "session-synthetic", boundAt: "2026-08-01T20:25:14+08:00" }],
        },
        documentClaim: { ...claim, path: "facts/F-ABCDEFGH.md" },
      },
    },
  } as CanonicalEventV1;
}

function migrationDecisionEventWithLegacyDecisionTimestamp(): CanonicalEventV1 {
  const event = migrationDecisionEvent() as CanonicalEventV1 & {
    payload: { entity: { decision: { decidedAt: string } } };
  };
  event.occurredAt = "2026-06-03T00:00:00.000Z";
  event.payload.entity.decision.decidedAt = "2026-06-03T00:00:00+08:00";
  return event;
}

function legacyDecisionProposal(): CanonicalEventV1 {
  const decisionId = "dec_SYNTHETIC_PROPOSAL";
  return {
    schema: "decision-event/v1",
    eventId: "event-proposal-synthetic",
    workspaceRevision: 4,
    opId: "op-proposal-synthetic",
    decisionId,
    type: "decision_proposed",
    actor,
    source: "local",
    occurredAt: "2026-08-14T00:00:00.000Z",
    payload: {
      title: "Synthetic proposal",
      question: "Use the current shape?",
      riskTier: "medium",
      urgency: "medium",
      vertical: "software/coding",
      preset: "standard-task",
      appliesTo: { modules: ["kernel"], productLines: [] },
      decisionClass: "ordinary",
      chosen: [{ id: "CH1", text: "Yes" }],
      rejected: [{ id: "RJ1", text: "No", whyNot: "Invalid" }],
      body: "Synthetic body",
      claims: [],
      fulfillments: [],
      relations: [],
      baseDocumentSha256: null,
      decisionDocumentClaim: {
        path: `decisions/decision-${decisionId}/decision.md`,
        sha256: "e".repeat(64),
        size: 1,
        mediaType: "text/markdown",
        policyId: DECISION_DOCUMENT_POLICY_ID,
      },
    },
  } as CanonicalEventV1;
}

function legacyDocEvent(): CanonicalEventV1 {
  return {
    schema: "doc-event/v1",
    eventId: "event-doc-synthetic",
    workspaceRevision: 2,
    opId: "op-doc-synthetic",
    type: "documents_written",
    actor,
    source: { kind: "watch_session", sessionId: "watch-synthetic", path: "notes.json", fingerprint: "f".repeat(64) },
    occurredAt: "2026-08-14T00:00:00.000Z",
    payload: {
      executionId: null,
      baseLedgerSha: { repoId: "synthetic", sha: "a".repeat(40) },
      changes: [
        {
          path: "notes.json",
          baseBlobSha256: null,
          candidate: { sha256: "a".repeat(64), size: 1, mediaType: "application/json" },
          policyId: OPAQUE_TEXTUAL_POLICY_ID,
          regionProofs: [],
        },
      ],
    },
  } as CanonicalEventV1;
}
