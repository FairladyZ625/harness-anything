import assert from "node:assert/strict";
import { createHash, Hash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { durableActionKinds, getExecutableEntityAction } from "@harness-anything/kernel";
import { measureWorktreeDocuments } from "./g38-worktree-document-cost.mjs";
import { DECISION_PROBES, measureDecisionCollection } from "./g38-decision-cost.mjs";
import {
  measureTaskReviewConsent,
  measureTaskReviewExecution,
  measureTaskReviewResponses,
} from "./g38-lifecycle-cost.mjs";

export const COLLECTION_SCALES = Object.freeze({ small: 100, large: 2000 });

function counted(values, count) {
  return new Proxy(values, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^(0|[1-9]\d*)$/u.test(property)) count();
      return Reflect.get(target, property, receiver);
    },
  });
}

const load = (rootDir, relative) => import(pathToFileURL(path.join(rootDir, relative)).href);

// Exercise the production submission orchestration, including its reader lifetime. A reader-only
// benchmark misses moving createSubmissionArtifactReader inside the per-artifact loop (#4207).
export async function measureTaskSubmitArtifacts(rootDir, size) {
  const [{ deriveCloseoutSubmission }, { completionSnapshot }] = await Promise.all([
    load(rootDir, "packages/daemon/src/repo-cell-submit.ts"),
    load(rootDir, "packages/kernel/test/domain/completion.fixtures.ts"),
  ]);
  const packagePath = "tasks/task-artifact",
    content = Buffer.from("Accepted task output.\n"),
    blobSha256 = createHash("sha256").update(content).digest("hex"),
    paths = Array.from(
      { length: size },
      (_, index) => `${packagePath}/artifacts/file-${String(index).padStart(4, "0")}.md`,
    ),
    pathSet = new Set(paths),
    counts = { acceptanceReads: 0, claimsExamined: 0, blobReads: 0 },
    claims = counted(
      paths.map((target) => ({ path: target, candidate: { sha256: blobSha256 } })),
      () => {
        counts.claimsExamined += 1;
      },
    ),
    body =
      "## Summary\nMeasured submission.\n## Verification\nCounted production work.\n## Residual Risk\nNone identified.\n## Same Mechanism Elsewhere\nChecked sibling.\n",
    event = { schema: "doc-event/v1", workspaceRevision: 7, opId: "accepted-7", payload: { changes: claims } },
    cell = {
      rootDir: "/nonexistent",
      cellCodedError: (code, message) => Object.assign(new Error(message), { code }),
      settings: { readRepository: () => ({ gates: [] }) },
      store: {
        readEventAtRevision: () => {
          counts.acceptanceReads += 1;
          return event;
        },
        readContentBlob: () => {
          counts.blobReads += 1;
          return content;
        },
      },
      projection: {
        readPresetSnapshot: () => ({ snapshot: completionSnapshot }),
        readDocuments: () => ({ documents: paths.map((target) => ({ path: target })) }),
        readRuntimeDispatchesByTaskExecution: () => [],
        read: () => ({ watermark: 7, sourceRevision: 7, snapshot: { task: {} }, packagePath }),
        readDocument: (target) => ({
          watermark: 7,
          sourceRevision: 7,
          document: {
            workspaceRevision: pathSet.has(target) ? 7 : undefined,
            body: target.endsWith("task-contract.json")
              ? JSON.stringify({
                  documents: [
                    {
                      slot: "task.closeout",
                      path: "closeout.md",
                      templateRef: "template://planning/closeout@1",
                      locale: "en-US",
                    },
                  ],
                })
              : body,
          },
        }),
      },
    },
    submission = deriveCloseoutSubmission(cell, "task-artifact", "execution", {
      task: { presetSnapshotDigest: completionSnapshot.digest, completionGateIds: [] },
      executions: [],
      reviews: [],
    });
  assert.equal(submission.artifacts.length, size, "submit must freeze every artifact");
  assert.deepEqual(submission.deliverables, paths);
  return { size, counts };
}

// Exercise the canonical task-witness-run catalog writer. Its input is one task execution's
// frozen command-gate collection; the request must find the requested gate and validate it.
export async function measureTaskWitnessGates(rootDir, size) {
  const [{ readTaskWitnessRequest }, { completionSnapshot }] = await Promise.all([
      load(rootDir, "packages/daemon/src/task-witness-request.ts"),
      load(rootDir, "packages/kernel/test/domain/completion.fixtures.ts"),
    ]),
    gates = Array.from({ length: size }, (_, index) => ({
      gateId: `gate-${String(index).padStart(4, "0")}`,
      appliesTo: "submission",
      witness: { kind: "command", adapterId: `adapter-${index}`, adapterOptions: {} },
    })),
    execution = {
      schema: "execution/v1",
      executionId: "execution-cost",
      iteration: 1,
      submission: {
        ...completionSnapshot,
        completionContract: { ...completionSnapshot.completionContract, gates },
        commitSha: "a".repeat(40),
        artifacts: [],
      },
      gateRuns: [],
    },
    counts = { gateMembersRead: 0 },
    task = {
      status: "submitted",
      iteration: 1,
      taskId: "task-cost",
    },
    projection = {
      read(taskId) {
        assert.equal(taskId, "task-cost");
        return { snapshot: { task, executions: [execution], gateWitnesses: [] } };
      },
    },
    cell = {
      projection,
      cellCodedError(code, message) {
        return Object.assign(new Error(message), { code });
      },
    };
  execution.submission.completionContract.gates = counted(gates, () => {
    counts.gateMembersRead += 1;
  });
  const result = readTaskWitnessRequest(cell, {
    taskId: "task-cost",
    executionId: "execution-cost",
    gateId: gates.at(-1).gateId,
  });
  assert.equal(result.result.gateId, gates.at(-1).gateId);
  return { size, counts };
}

// Synchronous scopes keep probe work and setup out of the measured window. Hash.update counts
// bytes as well as calls: a fixed number of hashes over a quadratic-size event must still fail.
function measureHashes(run) {
  const counts = { sha256Calls: 0, sha256Bytes: 0 },
    update = Hash.prototype.update;
  Hash.prototype.update = function (chunk, encoding) {
    counts.sha256Calls += 1;
    counts.sha256Bytes += typeof chunk === "string" ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
    return update.call(this, chunk, encoding);
  };
  try {
    run();
    return counts;
  } finally {
    Hash.prototype.update = update;
  }
}

export async function measureDocuments(rootDir, size, bodyUnits = 1) {
  const { decide, claim, baseLedgerSha } = await load(rootDir, "packages/kernel/test/contracts/doc-sync.fixtures.ts"),
    { DOC_POLICY_ID } = await load(rootDir, "packages/kernel/src/domain/doc-sync.contract.ts"),
    body = "Measured prose. ".repeat(bodyUnits) + "\n",
    candidate = claim(body),
    changes = Array.from({ length: size }, (_, index) => ({
      path: `context/cost-${String(index).padStart(4, "0")}.md`,
      baseBlobSha256: null,
      policyId: DOC_POLICY_ID,
      candidate,
    }));
  let arrayItems = 0;
  const visit = () => {
      arrayItems += 1;
    },
    hashes = measureHashes(() => {
      const result = decide(changes[0], null, Buffer.from(body), {
        intent: {
          schema: "doc-write-intent/v1",
          executionId: "execution-1",
          baseLedgerSha,
          changes: counted(changes, visit),
        },
        documents: counted(Array(size).fill(null), visit),
        claims: counted(Array(size).fill(Buffer.from(body)), visit),
      });
      assert.equal(result.accepted, true, JSON.stringify(result));
      assert.equal(result.event.payload.changes.length, size, "doc write must accept every document");
    });
  return { size: bodyUnits === 1 ? size : bodyUnits, counts: { arrayItems, ...hashes } };
}

export async function measureRelations(rootDir, size) {
  const { readRelationCycleWitnessAtCut } = await load(rootDir, "packages/daemon/src/entity-action-relation.ts"),
    counts = { queries: 0, rowsExamined: 0 },
    // A single owner has N outgoing edges; each target is a distinct leaf. This crosses the
    // production page boundary (100), unlike seeding N unrelated one-edge owners.
    rows = Array.from({ length: size }, (_, index) => ({
      relationId: `edge-${index}`,
      sourceRef: "task/target",
      targetRef: `task/leaf-${index}`,
      relationType: "depends-on",
      direction: "directed",
      state: "active",
    })),
    witness = readRelationCycleWitnessAtCut({
      headRevision: 7,
      candidate: {
        relationId: "candidate",
        sourceRef: "task/source",
        targetRef: "task/target",
        relationType: "depends-on",
        direction: "directed",
        state: "active",
      },
      projection: {
        readRelationQuery(query) {
          counts.queries += 1;
          const offset = Number(query.cursor ?? 0),
            page = query.source === "task/target" ? rows.slice(offset, offset + query.limit) : [];
          return {
            status: "ready",
            watermark: 7,
            sourceRevision: 7,
            rows: counted(page, () => {
              counts.rowsExamined += 1;
            }),
            page: {
              limit: query.limit,
              cursor: query.cursor ?? null,
              nextCursor:
                query.source === "task/target" && offset + page.length < size ? String(offset + page.length) : null,
            },
          };
        },
      },
    });
  assert.equal(witness, null);
  assert.ok(counts.rowsExamined >= size, "admission must visit all related edges");
  return { size, counts };
}

/**
 * dec_E34C4284B48AFAF152D7BF1980 CH2: an endpoint version change recomputes the stored freshness
 * of the relations anchored on that endpoint, located through the endpoint index, in the same
 * projection transaction. The cost is linear in that endpoint's relations; an equally large
 * collection anchored on another endpoint must not be visited.
 */
export async function measureAnchoredRelationFreshness(rootDir, size) {
  const [{ DatabaseSync }, { refreshDirtyRelationFreshness }, fixtures, { withTempStore }] = await Promise.all([
    import("node:sqlite"),
    load(rootDir, "packages/storage/src/projection/relation-freshness-maintenance.ts"),
    load(rootDir, "packages/storage/test/store/relation-graph-projection.fixtures.ts"),
    load(rootDir, "packages/storage/test/store/helpers.ts"),
  ]);
  return withTempStore((storeRoot) => {
    const fixture = fixtures.projectionFixture(storeRoot);
    let revision = 0;
    const apply = (event) => {
      fixture.appendEvent(event);
      fixture.projection.apply(event);
    };
    for (const taskId of ["task_hot", "task_cold"]) apply(fixtures.taskCreated(++revision, taskId));
    for (const target of ["task/task_hot", "task/task_cold"])
      for (let index = 0; index < size; index += 1) {
        const { strength: _strength, ...record } = fixtures.relation({
          source: `task/task_source_${index}`,
          target,
          type: "relates",
        });
        apply({
          schema: "relation-event/v1",
          eventId: `event-${++revision}`,
          workspaceRevision: revision,
          opId: `op-${revision}`,
          relationId: record.relation_id,
          type: "relation_created",
          actor: fixtures.actor,
          source: "local",
          occurredAt: "2026-11-06T00:00:00.000Z",
          payload: { relation: { ...record, targetObservedVersion: null } },
        });
      }
    const projectionPath = fixture.projection.path;
    fixture.projection.close();
    const db = new DatabaseSync(projectionPath);
    try {
      const changes = () => Number(db.prepare("SELECT total_changes() AS n").get().n);
      assert.equal(refreshDirtyRelationFreshness(db), 0);
      db.prepare("UPDATE task_snapshot SET workspace_revision = ? WHERE task_id = 'task_hot'").run(++revision);
      const before = changes(),
        relationsRecomputed = refreshDirtyRelationFreshness(db),
        rowsWritten = changes() - before,
        suspect = Number(
          db
            .prepare(
              "SELECT count(*) AS n FROM relation_edge WHERE target_ref = 'task/task_hot' AND freshness = 'suspect'",
            )
            .get().n,
        );
      assert.equal(relationsRecomputed, size, "only the changed endpoint's relations are recomputed");
      assert.equal(suspect, size);
      return { size, counts: { relationsRecomputed, rowsWritten } };
    } finally {
      db.close();
    }
  });
}

export async function measureEntityPins(rootDir, size, actionKind) {
  const { runEntityPinAction } = await load(rootDir, "packages/daemon/src/entity-pin-action.ts"),
    entityRef = "task/task_cost",
    counts = { pinsExamined: 0, appendedEvents: 0 },
    rows = Array.from({ length: size }, (_, index) => ({
      entityRef: actionKind === "entity-unpin" && index === size - 1 ? entityRef : `task/task_pin_${index}`,
    })),
    actor = { principal: { personId: "pin-cost" }, executor: null },
    revision = 7000,
    cell = {
      input: { repoId: "g38-pin" },
      projection: {
        readEntityVersionWitness: () => ({ currentVersion: 1 }),
        listPinnedEntities: () =>
          counted(rows, () => {
            counts.pinsExamined += 1;
          }),
        apply() {},
        readOperation: () => ({ watermark: revision + 1 }),
      },
      store: {
        readHead: () => ({ revision }),
        append(bundle) {
          counts.appendedEvents += 1;
          return { revision: bundle.event.workspaceRevision };
        },
      },
      settings: { readRepository: () => ({ agenda: { pinLimit: size + 1 } }) },
      operationId: () => `pin-${actionKind}`,
      cellCodedError: (code, message) => Object.assign(new Error(message), { code }),
      publicPublication: () => ({}),
      now: () => "2026-11-02T00:00:00.000Z",
    },
    result = runEntityPinAction(cell, { kind: actionKind, entityRef }, { actor, source: "local" });
  assert.equal(result.outcome, "applied", JSON.stringify(result));
  assert.equal(counts.appendedEvents, 1);
  assert.ok(counts.pinsExamined >= size, "pin write must scan the existing pin collection");
  return { size, counts };
}

export async function measureTaskReviewDispatchBatch(rootDir, size) {
  const [{ dispatchTaskReview, reviewDispatchIds }, { completionSnapshot }] = await Promise.all([
      load(rootDir, "packages/daemon/src/task-review-dispatch.ts"),
      load(rootDir, "packages/kernel/test/domain/completion.fixtures.ts"),
    ]),
    ids = Array.from({ length: size }, (_, index) => `task-review-${index}`),
    events = new Map(),
    counts = {
      taskIdsRead: 0,
      taskProjectionsRead: 0,
      leaseIntervalsRead: 0,
      dispatchSteps: 0,
      publications: 0,
    },
    taskIds = new Proxy(ids, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^(0|[1-9]\d*)$/u.test(property)) counts.taskIdsRead += 1;
        return Reflect.get(target, property, receiver);
      },
    }),
    executionFor = (taskId) => ({
      schema: "execution/v1",
      taskId,
      executionId: `execution_${taskId}`,
      iteration: 1,
      state: "submitted",
      actor: { principal: { personId: "cost-worker" }, executor: { kind: "agent", id: "worker-cost" } },
      claimedAt: "2026-11-02T00:00:00.000Z",
      submittedAt: "2026-11-02T00:01:00.000Z",
      closedAt: null,
      submission: {
        ...completionSnapshot,
        commitSha: "a".repeat(40),
        artifacts: [],
      },
    }),
    leaseIntervalFor = (taskId) => {
      const executionId = executionFor(taskId).executionId;
      return {
        taskId,
        executionId,
        holder: {
          taskId,
          executionId,
          actor: { principal: { personId: "cost-worker" }, executor: { kind: "agent", id: "worker-cost" } },
          source: "local",
        },
        previousHolder: null,
        acquiredRevision: 1,
        releasedRevision: null,
        leaseExpiresAt: "2026-11-02T01:00:00.000Z",
        reason: "initial_claim",
      };
    },
    cell = {
      rootDir,
      cellCodedError: (code, message) => Object.assign(new Error(message), { code }),
      operationId: () => "g38-review-dispatch",
      input: { repoId: "g38-review-dispatch" },
      store: {
        readHead: () => ({ revision: 1 }),
        readBatch: (cursor) => ({ sourceRevision: 1, events: [], cursor, done: true, accessedItems: 0 }),
        readContentBlob: () => null,
      },
      projection: {
        read(taskId) {
          counts.taskProjectionsRead += 1;
          const execution = executionFor(taskId);
          return {
            watermark: 1,
            sourceRevision: 1,
            packagePath: `tasks/${taskId}`,
            snapshot: {
              task: {
                taskId,
                status: "in_review",
                currentNode: "review",
                iteration: 1,
                completionGateIds: [],
                reviewer: "closeout-reviewer",
              },
              executions: [execution],
              reviews: [],
            },
          };
        },
        readLatestLeaseIntervalForExecution(taskId, executionId) {
          // Placement reads one indexed task/execution interval. Keep this fixture's history
          // independent of the batch size so G38 measures the supplied task-id collection.
          counts.leaseIntervalsRead += 1;
          const interval = leaseIntervalFor(taskId);
          return interval.executionId === executionId ? interval : null;
        },
        readRuntimeDispatchByDispatchKey(key) {
          const event = events.get(key);
          return event ? { event } : null;
        },
        readRuntimeDispatchesByTaskExecution: () => [],
        readRuntimeSessionEvents: () => [],
        readRuntimeSessionEventsByType: () => [],
      },
      settings: { readRepository: () => ({ roles: { defaultReviewer: "closeout-reviewer" } }) },
      now: () => "2026-11-02T00:00:00.000Z",
      runtimeSpawner: {
        prepareWorktree: async () => ({ path: rootDir, cleanup: async () => undefined }),
        async spawn(payload) {
          const dispatchIds = reviewDispatchIds("g38-review-dispatch", payload.dispatchKey);
          counts.publications += 1;
          events.set(payload.dispatchKey, {
            opId: dispatchIds.dispatchOpId,
            payload: {
              ...dispatchIds,
              taskId: payload.taskId,
              executionId: payload.executionId,
              agentId: payload.agentId,
              role: "reviewer",
              dispatchKey: payload.dispatchKey,
              instanceId: "g38-isolated-runtime",
            },
          });
          return { runtimeSelection: { instanceId: "g38-isolated-runtime" } };
        },
      },
    },
    binding = {
      actor: { principal: { personId: "cost-owner" }, executor: null },
      source: { kind: "node" },
      keycloakAuthorization: {
        session: {
          personId: "cost-owner",
          accessToken: "g38-token",
          url: "https://g38.invalid",
          realm: "g38",
          clientId: "g38",
          provider: {
            policyRef: "g38-policy@1",
            authority: "g38-isolated-authorization",
            deniedReasonCode: "g38_denied",
            authorize: async () => ({ outcome: "allowed", reasonCode: "g38_allowed" }),
            validateUserAccessToken: async () => true,
            withFetchPort() {
              return this;
            },
          },
        },
      },
    },
    result = await dispatchTaskReview(cell, { kind: "task-dispatch-review", taskIds }, binding);
  counts.dispatchSteps = result.dispatches.length;
  assertTaskReviewDispatchMeasurement(result, size, counts.publications);
  assert.ok(counts.taskProjectionsRead >= size);
  assert.equal(counts.leaseIntervalsRead, size);
  return { size, counts };
}

export function assertTaskReviewDispatchMeasurement(result, size, publications) {
  assert.equal(
    result.outcome,
    "applied",
    `dispatch measurement must reach the successful write path: ${JSON.stringify(result)}`,
  );
  assert.equal(result.dispatches?.length, size, "every task must produce a dispatch step");
  assert.ok(
    result.dispatches.every((step) => step.outcome === "dispatched"),
    "every task must be dispatched",
  );
  assert.equal(publications, size, "every dispatch must publish through the isolated port");
}

export async function measureTaskAmendPatches(rootDir, size) {
  const { taskMutation } = await load(rootDir, "packages/daemon/src/repo-cell-task-mutation.ts"),
    counts = { patchesExamined: 0 },
    patches = counted(
      Array.from({ length: size }, () => ({ field: "reviewer", value: "closeout-reviewer" })),
      () => (counts.patchesExamined += 1),
    ),
    task = { taskId: "task-amend-cost", reviewer: "previous-reviewer", metadata: null },
    cell = {
      requiredCellText(value, label) {
        assert.equal(typeof value, "string", `${label} must be text`);
        return value;
      },
      cellCodedError: (code, message) => Object.assign(new Error(message), { code }),
    },
    binding = { actor: { principal: { personId: "cost-owner" }, executor: null }, source: { kind: "node" } },
    result = taskMutation(cell, { kind: "task-amend", taskId: task.taskId, patches }, task, { lease: null }, binding);
  assert.equal(result.type, "task_amended");
  assert.equal(result.audit.fields.length, size);
  assert.ok(counts.patchesExamined >= size, "amend must examine every patch");
  return { size, counts };
}

// Keep one active assignment and grow that subject's retired assignment history. Growing N
// unrelated subjects would leave this production scan at size 1 and conceal its cost entirely.
export async function measureAssignmentHistory(rootDir, size, actionKind) {
  const [{ makeEntityActionCatalogExecutor }, { deriveRelationId }] = await Promise.all([
      load(rootDir, "packages/daemon/src/entity-action-catalog-executor.ts"),
      load(rootDir, "packages/kernel/src/domain/entity-relation.ts"),
    ]),
    contract = getExecutableEntityAction(actionKind),
    subject = `${contract.target.kind}/${contract.target.kind === "decision" ? "dec_0123456789ABCDEFGHJKMNPQRS" : contract.target.kind === "fact" ? "F-00000001" : contract.target.kind === "task" ? "task_cost" : "subject"}`,
    counts = { rowsExamined: 0, queries: 0, appendedEvents: 0 },
    rows = Array.from({ length: size }, (_, index) => ({
      relationId: deriveRelationId({
        source: subject,
        target: `person/previous-${index}`,
        type: "assigned-to",
        direction: "directed",
      }),
      sourceRef: subject,
      targetRef: `person/previous-${index}`,
      relationType: "assigned-to",
      workspaceRevision: index + 1,
      state: index === size - 1 ? "active" : "retired",
    })),
    headRevision = 5000,
    actor = { principal: { personId: "cost-writer" }, executor: null };
  let written;
  const executor = makeEntityActionCatalogExecutor({
      store: {
        readHead: () => ({ revision: headRevision }),
        readEvent: () => null,
        append(bundle) {
          written = bundle.event;
          counts.appendedEvents += 1 + (bundle.preceding?.length ?? 0);
          return { revision: written.workspaceRevision };
        },
      },
      projection: {
        currentLease: () => null,
        readDecision: () => ({ decision: { reviews: [], state: "proposed" } }),
        readCut: () => ({ status: "ready", watermark: headRevision }),
        readRelationQuery() {
          counts.queries += 1;
          return {
            rows: counted(rows, () => {
              counts.rowsExamined += 1;
            }),
          };
        },
        readEntityVersionWitness: (entityRef) => ({ entityRef, currentVersion: 1 }),
        readRelationEdge(id) {
          if (written && id === written.relationId)
            return { state: written.type === "relation_retired" ? "retired" : "active" };
          return id === rows.at(-1).relationId ? rows.at(-1) : null;
        },
        apply() {},
      },
      now: () => "2026-11-02T00:00:00.000Z",
      sessionIdentity: () => null,
      readSettings: () => ({ tasks: { assignmentTtlMs: 60000 } }),
    }),
    hashes = measureHashes(() => {
      const result = executor.run(
        {
          kind: actionKind,
          entityRef: subject,
          [contract.execution.targetIdField]: subject.slice(subject.indexOf("/") + 1),
          personId: "new-assignee",
          expectedVersion: size,
        },
        { actor, source: "local", authorizationDecision: { outcome: "allowed" } },
        "assignment-cost",
      );
      assert.equal(result.outcome, "applied", JSON.stringify(result));
    });
  assert.ok(counts.rowsExamined >= size, "must examine this subject's assignment history");
  assert.equal(counts.appendedEvents, contract.id === "assign" ? 2 : 1);
  return { size, counts: { ...counts, ...hashes } };
}

export async function measureCatalogBatch(rootDir, size, actionKind) {
  const [{ makeEntityActionCatalogExecutor }, { reduceDecisionDocument }] = await Promise.all([
      load(rootDir, "packages/daemon/src/entity-action-catalog-executor.ts"),
      load(rootDir, "packages/kernel/src/domain/decision-event.ts"),
    ]),
    actor = { principal: { personId: "cost-writer" }, executor: null },
    occurredAt = "2026-11-02T00:00:00.000Z",
    decision = reduceDecisionDocument(null, {
      decisionId: "dec_COST0000",
      type: "decision_proposed",
      actor,
      occurredAt,
      workspaceRevision: 1,
      payload: {
        title: "Measured decision",
        question: "Does batch repinning stay linear?",
        riskTier: "low",
        urgency: "medium",
        vertical: "software/coding",
        preset: "standard-task",
        decisionClass: "ordinary",
        appliesTo: { modules: ["daemon"], productLines: [] },
        chosen: [{ id: "CH1", text: "Measure batch writes." }],
        rejected: [],
        claims: [],
        fulfillments: [],
        relations: [],
        provenance: [],
      },
    }),
    ids = Array.from({ length: size }, (_, index) =>
      actionKind === "decision-repin"
        ? `dec_COST${String(index).padStart(4, "0")}`
        : `F-${index.toString(16).toUpperCase().padStart(8, "0")}`,
    ),
    counts = { rowsExamined: 0, factReads: 0, decisionReads: 0, documentReads: 0, appendedEvents: 0, appliedEvents: 0 },
    body = "---\nschema: decision-package/v1\n---\n\nMeasured decision body.\n",
    document = { body, blobSha256: createHash("sha256").update(body).digest("hex") };
  let revision = 5000,
    appended = false;
  const executor = makeEntityActionCatalogExecutor({
      now: () => occurredAt,
      sessionIdentity: () => ({ runtime: "unavailable", sessionId: null, transcriptReachability: "unavailable" }),
      readSettings: () => ({ decisionReviewRequirement: "off" }),
      store: {
        readHead: () => ({ revision: 5000 }),
        readEvent: () => null,
        readCommandOutcome: () =>
          appended ? { status: "accepted_durable", firstRevision: 5001, lastRevision: revision } : null,
        append(bundle) {
          counts.appendedEvents += 1 + (bundle.preceding?.length ?? 0);
          revision = bundle.event.workspaceRevision;
          appended = true;
          return { revision };
        },
      },
      projection: {
        readCut: () => ({ status: "ready", watermark: revision }),
        listDecisions: () => ({
          decisions: counted(
            ids.map((decisionId) => ({ decisionId })),
            () => {
              counts.rowsExamined += 1;
            },
          ),
        }),
        readDecision(decisionId) {
          counts.decisionReads += 1;
          return { watermark: 5000, sourceRevision: 5000, decision: { ...decision, decisionId } };
        },
        readDecisionIncomingRelations: () => [],
        readFact(factId) {
          counts.factReads += 1;
          return {
            fact: {
              factId,
              statement: "Measured fact.",
              evidenceSource: "g38:batch",
              observedAt: occurredAt,
              confidence: "high",
              memoryClass: "semantic",
              memoryTags: [],
              archived: false,
            },
          };
        },
        readDocument() {
          counts.documentReads += 1;
          return { watermark: 5000, sourceRevision: 5000, document };
        },
        apply() {
          counts.appliedEvents += 1;
        },
      },
    }),
    hashes = measureHashes(() => {
      const result = executor.run(
        actionKind === "decision-repin"
          ? { kind: actionKind, all: true, migrationEvidence: "task/task-cost/artifacts/evidence.md" }
          : {
              kind: actionKind,
              factIds: counted(ids, () => {
                counts.rowsExamined += 1;
              }),
              reason: "Measured archive batch.",
            },
        { actor, source: "local", authorizationDecision: { outcome: "allowed" } },
        "batch-cost",
      );
      assert.equal(result.outcome, "applied", JSON.stringify(result));
    });
  assert.equal(counts.appendedEvents, size, "batch must publish every selected member");
  assert.equal(counts.appliedEvents, size, "batch must project every selected member");
  return { size, counts: { ...counts, ...hashes } };
}

export async function measureCollectionCosts(rootDir, scales = COLLECTION_SCALES) {
  const measured = {};
  for (const [id, { run }] of Object.entries(COLLECTION_PROBES))
    measured[id] = { small: await run(rootDir, scales.small), large: await run(rootDir, scales.large) };
  return measured;
}

export const COLLECTION_PROBES = Object.freeze({
  ...DECISION_PROBES,
  "entity-pin:agenda-pins": {
    action: "entity-pin",
    dimension: "agenda-pins",
    run: (root, n) => measureEntityPins(root, n, "entity-pin"),
  },
  "entity-unpin:agenda-pins": {
    action: "entity-unpin",
    dimension: "agenda-pins",
    run: (root, n) => measureEntityPins(root, n, "entity-unpin"),
  },
  "task-respond-review:responses": {
    action: "task-respond-review",
    dimension: "review-responses",
    run: (root, n) => measureTaskReviewResponses(root, n),
  },
  "task-review-execution:findings": {
    action: "task-review-execution",
    dimension: "findings",
    run: (root, n) => measureTaskReviewExecution(root, n, "findings"),
  },
  "task-review-execution:evidence-checked": {
    action: "task-review-execution",
    dimension: "evidence-checked",
    run: (root, n) => measureTaskReviewExecution(root, n, "evidenceChecked"),
  },
  "task-review-execution:resolutions": {
    action: "task-review-execution",
    dimension: "resolutions",
    run: (root, n) => measureTaskReviewExecution(root, n, "resolutions"),
  },
  "task-review-consent:reviews": {
    action: "task-review-consent",
    dimension: "reviews",
    run: (root, n) => measureTaskReviewConsent(root, n, "reviews"),
  },
  "task-review-consent:consents": {
    action: "task-review-consent",
    dimension: "consents",
    run: (root, n) => measureTaskReviewConsent(root, n, "consents"),
  },
  "task-review-consent:dispositions": {
    action: "task-review-consent",
    dimension: "dispositions",
    run: (root, n) => measureTaskReviewConsent(root, n, "dispositions"),
  },
  "task-amend:patches": {
    action: "task-amend",
    dimension: "patches",
    run: measureTaskAmendPatches,
  },
  "task-amend:anchored-relations": {
    action: "task-amend",
    dimension: "anchored-relations",
    run: measureAnchoredRelationFreshness,
  },
  "task-dispatch-review:task-ids": {
    action: "task-dispatch-review",
    dimension: "task-ids",
    run: measureTaskReviewDispatchBatch,
  },
  "task-witness-run:frozen-gates": {
    action: "task-witness-run",
    dimension: "frozen-gates",
    run: measureTaskWitnessGates,
  },
  "decision-respond-review:review-findings": {
    action: "decision-respond-review",
    dimension: "review-findings",
    run: (root, n) => measureDecisionCollection(root, n, "decision-respond-review", "review-findings"),
  },
  "decision-repin:decisions": {
    action: "decision-repin",
    dimension: "decisions",
    run: (root, n) => measureCatalogBatch(root, n, "decision-repin"),
  },
  "fact-archive:facts": {
    action: "fact-archive",
    dimension: "facts",
    run: (root, n) => measureCatalogBatch(root, n, "fact-archive"),
  },
  ...Object.fromEntries(
    durableActionKinds.flatMap((kind) => {
      const contract = getExecutableEntityAction(kind);
      return contract && ["assign", "unassign"].includes(contract.id)
        ? [
            [
              `${kind}:assignment-history`,
              {
                action: kind,
                dimension: "assignment-history",
                run: (rootDir, size) => measureAssignmentHistory(rootDir, size, kind),
              },
            ],
          ]
        : [];
    }),
  ),
  "task-submit:worktree-documents": {
    action: "task-submit",
    dimension: "worktree-documents",
    run: measureWorktreeDocuments,
  },
  "task-submit:task-artifacts": { action: "task-submit", dimension: "task-artifacts", run: measureTaskSubmitArtifacts },
  "doc-submit:documents": { action: "doc-submit", dimension: "documents", run: measureDocuments },
  "doc-submit:event-bytes": {
    action: "doc-submit",
    dimension: "event-bytes",
    run: (rootDir, size) => measureDocuments(rootDir, 1, size),
  },
  "relation-relate:owner-relations": { action: "relation-relate", dimension: "owner-relations", run: measureRelations },
  "task-create:work-tasks": {
    action: "task-create",
    dimension: "work-tasks",
    async run(rootDir, size) {
      const { measureWriteCostScaling } = await load(rootDir, "packages/daemon/test/fixtures/g1-write-cost-scaling.ts"),
        result = await measureWriteCostScaling(3000, { workTaskCount: size });
      return { size, counts: result.counts["task-create"] };
    },
  },
});
