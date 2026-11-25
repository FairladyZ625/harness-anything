// harness-test-tier: contract
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  canonicalLedgerCut,
  createScheduleV1,
  DOC_POLICY_ID,
  RAW_ARTIFACT_POLICY_ID,
  sha256Bytes,
  sha256Text,
  type CanonicalEventV1,
  type CanonicalSquadRun,
  type ScheduleV1,
  type TaskProjectionQueries,
  type TaskV2,
} from "@harness-anything/kernel";
import { compileScheduleRunEvent } from "@harness-anything/kernel/internal/domain/schedule-event";
import {
  adjudicateDocIntent,
  listCanonicalDocuments,
  listProjectedTaskDocuments,
  makeSquadCanonicalReader,
  parseNodeDocIntent,
  readCanonicalRuntimeResult,
  readDocAction,
  readProjectedDocument,
  readScheduleRuns,
  readSchedulesGui,
  readSquadRecoveryStateFromControl,
  scheduleActionFacet,
  scheduleRunReportRefs,
  squadRunListQuery,
  squadState,
} from "@harness-anything/application/queries";

const actor = { principal: { personId: "person_owner" }, executor: null } as const;
const STATELESS_ROOT = path.join(path.parse(process.cwd()).root, "harness-stateless-query");

test("DocSync application queries serve canonical doc-show, doc-list, and task documents without local FS", () => {
  const textBody = "# Plan\nHello cloud\n";
  const textSha = sha256Text(textBody);
  const binBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const binSha = sha256Bytes(binBytes);
  const task: TaskV2 = {
    taskId: "task_doc_1",
    taskClass: "standard",
    title: "Doc task",
    status: "active",
    packageDisposition: "active",
    iteration: 1,
  } as unknown as TaskV2;

  const docs = new Map([
    [
      "tasks/task_doc_1-demo/task_plan.md",
      {
        path: "tasks/task_doc_1-demo/task_plan.md",
        body: textBody,
        blobSha256: textSha,
        size: Buffer.byteLength(textBody),
        mediaType: "text/markdown",
        policyId: "markdown-doc",
        workspaceRevision: 5,
      },
    ],
    [
      "tasks/task_doc_1-demo/artifacts/chart.png",
      {
        path: "tasks/task_doc_1-demo/artifacts/chart.png",
        body: "",
        blobSha256: binSha,
        size: binBytes.byteLength,
        mediaType: "image/png",
        policyId: RAW_ARTIFACT_POLICY_ID,
        workspaceRevision: 6,
      },
    ],
  ]);

  const projection = {
    read: (taskId: string) => ({
      status: "ready" as const,
      watermark: 6,
      sourceRevision: 6,
      packagePath: taskId === "task_doc_1" ? "tasks/task_doc_1-demo" : null,
      snapshot: { task: taskId === "task_doc_1" ? task : null, executions: [], lease: null, revision: 6 },
    }),
    readDocument: (logical: string) => ({
      status: "ready" as const,
      watermark: 6,
      sourceRevision: 6,
      document: docs.get(logical) ?? null,
    }),
    readDocumentHistory: () => ({
      status: "ready" as const,
      watermark: 6,
      sourceRevision: 6,
      document: null,
    }),
    readDocuments: (prefix: string) => ({
      status: "ready" as const,
      watermark: 6,
      sourceRevision: 6,
      documents: [...docs.values()]
        .filter((d) => d.path.startsWith(prefix))
        .map(({ path, blobSha256, size, mediaType }) => ({ path, blobSha256, size, mediaType })),
      page: { nextPath: null },
    }),
    taskIdForDocumentPath: (logical: string) => (logical.startsWith("tasks/task_doc_1-demo/") ? "task_doc_1" : null),
    readTaskRelationsByTargets: () => ({ rows: [] }),
    readTaskStatuses: () => ({ rows: [] }),
    currentLease: () => null,
    currentLeaseForExecution: () => null,
    readRuntimeSession: () => null,
  } as unknown as TaskProjectionQueries;

  const blobs = new Map<string, Uint8Array>([
    [textSha, Buffer.from(textBody)],
    [binSha, binBytes],
  ]);
  const store = {
    currentCut: () =>
      canonicalLedgerCut("repo-1", { revision: 6, opId: "op-6", eventDigest: `sha256:${"a".repeat(64)}` }),
    readContentBlob: (sha: string) => blobs.get(sha) ?? null,
    readContentBlobRange: (sha: string, offset: number, length: number) => {
      const b = blobs.get(sha);
      return b ? b.subarray(offset, offset + length) : null;
    },
    readContentBlobSize: (sha: string) => blobs.get(sha)?.byteLength ?? null,
  };

  // 1. Canonical doc-list
  const listed = listCanonicalDocuments(projection, { prefix: "tasks/", limit: 20 });
  assert.equal(listed.ok, true);
  assert.equal(listed.documents.length, 2);

  // 2. Canonical doc-show (full + ranged + pin mismatch)
  const shown = readDocAction({
    action: { kind: "doc-show", path: "tasks/task_doc_1-demo/task_plan.md" },
    binding: { actor, source: "local" },
    rootDir: STATELESS_ROOT,
    store,
    projection,
    now: () => "2026-11-25T00:00:00.000Z",
  });
  assert.equal(shown.outcome, "applied");
  assert.equal(shown.evidence, textBody);

  const ranged = readDocAction({
    action: {
      kind: "doc-show",
      path: "tasks/task_doc_1-demo/task_plan.md",
      offset: 0,
      length: 6,
      contentSha256: textSha,
      contentRevision: 5,
    },
    binding: { actor, source: "local" },
    rootDir: STATELESS_ROOT,
    store,
    projection,
    now: () => "2026-11-25T00:00:00.000Z",
  }) as unknown as { evidence: string; evidenceDone: boolean };
  assert.equal(Buffer.from(ranged.evidence, "base64").toString("utf8"), "# Plan");
  assert.equal(ranged.evidenceDone, false);

  assert.throws(
    () =>
      readDocAction({
        action: {
          kind: "doc-show",
          path: "tasks/task_doc_1-demo/task_plan.md",
          offset: 0,
          length: 6,
          contentSha256: "f".repeat(64),
          contentRevision: 5,
        },
        binding: { actor, source: "local" },
        rootDir: STATELESS_ROOT,
        store,
        projection,
        now: () => "2026-11-25T00:00:00.000Z",
      }),
    (err: unknown) => err instanceof Error && (err as { code?: string }).code === "content_changed",
  );

  // 3. Task documents list + task document preview (text, binary from content blob, authored-copy unobservable)
  const taskDocs = listProjectedTaskDocuments(projection, { taskId: "task_doc_1" });
  assert.deepEqual(
    taskDocs.documents.map((d) => d.path),
    ["artifacts/chart.png", "task_plan.md"],
  );
  assert.equal(
    taskDocs.documents.every((d) => d.uncommitted === false),
    true,
  );

  const binPreview = readProjectedDocument(
    { rootDir: STATELESS_ROOT, projection, store },
    { taskId: "task_doc_1", path: "artifacts/chart.png", view: "canonical" },
  );
  assert.equal(binPreview.source, "canonical");
  assert.equal(binPreview.contentKind, "binary");
  assert.equal(binPreview.bytes, Buffer.from(binBytes).toString("base64"));

  const authoredMissing = readProjectedDocument(
    { rootDir: STATELESS_ROOT, projection, store },
    { taskId: "task_doc_1", path: "task_plan.md", view: "authored-copy" },
  );
  assert.equal(authoredMissing.source, "unobservable");
  assert.equal(authoredMissing.unobservableReason, "authored_copy_not_observed");

  // 4. Pure node intent parsing + adjudication fail-closed without authorization decision
  const cut = store.currentCut();
  const intent = parseNodeDocIntent({
    workspaceId: "repo-1",
    action: {
      kind: "doc-submit",
      executionId: null,
      baseLedgerSha: cut,
      changes: [
        {
          path: "docs/guide.md",
          baseBlobSha256: null,
          policyId: DOC_POLICY_ID,
          candidate: {
            ref: "doc-sync-claims/guide.md",
            sha256: textSha,
            size: Buffer.byteLength(textBody),
            mediaType: "text/markdown",
          },
        },
      ],
    },
  });
  assert.throws(
    () =>
      adjudicateDocIntent(
        {
          binding: { actor, source: "local" },
          workspaceId: "repo-1",
          store,
          projection,
          now: () => "2026-11-25T00:00:00.000Z",
        },
        intent,
        [],
        null,
        "op-test",
      ),
    (err: unknown) => err instanceof Error && (err as { code?: string }).code === "authorization_missing",
  );
});

test("Squad application queries assemble canonical list/read/status and recovery fold without host FS", () => {
  const resultText = '{"schema":"runtime-batch/v1","dispatches":[]}';
  const resultSha = sha256Text(resultText);
  const resultRef = `artifact:runtime-result/sha256/${resultSha}`;
  const runId = "squad_0123456789abcdef01234567";
  const canonicalRun: CanonicalSquadRun = {
    schema: "squad-run-observation/v1",
    squadRunId: runId,
    squadId: "core-squad",
    ownerDispatchId: "dispatch_0123456789abcdef01234567",
    owner: { source: "local", personId: "person_owner" },
    subject: { kind: "task", taskId: "task_sq_1", executionId: "exec_1" },
    mission: "Implement slice 3",
    phase: "converged",
    error: null,
    currentLeaderRuntimeSessionId: null,
    runRevision: 3,
    acceptedRevision: 10,
    acceptedAt: "2026-11-25T00:00:00.000Z",
    workerCallbackCount: 1,
    pendingLeaderCallbackCount: 0,
    leaderTurns: [
      {
        turnId: "turn-1",
        trigger: { kind: "initial" },
        dispatchId: "dispatch_000000000000000000000001",
        runtimeSessionId: "runtime_leader_1",
        decision: { kind: "converged" },
      },
    ],
    workerAttempts: [],
  };

  const projection = {
    readCut: () => ({ status: "ready" as const, watermark: 10, sourceRevision: 10 }),
    readSquadRuns: () => [{ squadRunId: runId, state: canonicalRun }],
    readSquadRun: (id: string) => (id === runId ? { squadRunId: runId, state: canonicalRun } : null),
    read: () => ({
      snapshot: {
        task: { taskId: "task_sq_1", iteration: 1 },
        executions: [{ executionId: "exec_1", iteration: 1 }],
      },
    }),
    readRuntimeSession: (id: string) =>
      id === "runtime_leader_1"
        ? { outcome: "succeeded", lastObservedAt: "2026-11-25T00:01:00.000Z", resultRef }
        : null,
    readRuntimeDispatch: () => ({
      payload: { startedAt: "2026-11-25T00:00:01.000Z" },
      occurredAt: "2026-11-25T00:00:01.000Z",
    }),
    readRuntimeSessionEventsByType: () => [],
    readDispatchLifecycle: () => ({
      attemptPhase: "closed",
      groupPhase: "closed",
      reservationState: "released",
      displayStatus: "succeeded",
    }),
    getEntity: () => null,
  } as unknown as TaskProjectionQueries;

  const reader = makeSquadCanonicalReader({
    projection,
    readResult: (ref) =>
      readCanonicalRuntimeResult(
        { readContentBlob: (sha) => (sha === resultSha ? Buffer.from(resultText) : null) },
        ref,
      ),
  });

  const listed = reader.list({ limit: 10, query: "slice" });
  assert.equal(listed.runs.length, 1);
  assert.equal(listed.totals.runs, 1);

  const detail = reader.read(runId);
  assert.equal(detail.ok, true);
  assert.equal("leaderTurns" in detail.run && detail.run.leaderTurns[0]?.resultText, resultText);

  const status = reader.status(runId);
  assert.equal(status.exitCode, 0);
  assert.equal(status.status, "converged");

  assert.throws(() => squadRunListQuery({ limit: 9999 }), /limit 1\.\.1000/u);

  const validState = squadState({
    schema: "squad-run/v1",
    squadRunId: runId,
    stateDispatchId: "dispatch_0123456789abcdef01234567",
    squadId: "core-squad",
    subject: { kind: "task", taskId: "task_sq_1", executionId: "exec_1" },
    publicMission: "Implement slice 3",
    leaderTurnBudget: 4,
    leaderTurns: [],
    workerAttempts: [],
    observedWorkerRuntimeSessionIds: [],
    workerWaits: [],
    pendingLeaderTriggers: [],
    phase: "leader_running",
    revision: 2,
    error: null,
    binding: {},
    currentLeaderRuntimeSessionId: null,
  });
  assert.ok(validState);
  const recovery = readSquadRecoveryStateFromControl(projection, () => ({ state: validState, ackRevision: 1 }));
  assert.equal(recovery.states.size, 1);
  assert.equal(recovery.protectedDispatchIds.has("dispatch_0123456789abcdef01234567"), true);
});

test("Schedule application queries assemble GUI list and run history with content-addressed reports", () => {
  const base = createScheduleV1({
    scheduleId: "nightly-audit",
    name: "Nightly audit",
    mode: "detect",
    spec: {
      trigger: { kind: "interval", everyMs: 3_600_000, anchorAt: "2026-11-25T00:00:00.000Z" },
      target: { kind: "agent", agentId: "auditor" },
      mission: "Inspect nightly drift.",
    },
    actor,
    occurredAt: "2026-11-25T00:00:00.000Z",
  });
  const reportText = "All invariants green.";
  const reportSha = sha256Text(reportText);
  const reportRef = `artifact:runtime-result/sha256/${reportSha}`;
  const settled: ScheduleV1 = {
    ...base,
    status: {
      ...base.status,
      automaticEvaluatedThrough: "2026-11-25T01:00:00.000Z",
      activeRun: null,
      lastRun: {
        occurrenceId: "occ-1",
        scheduledFor: "2026-11-25T01:00:00.000Z",
        endedAt: "2026-11-25T01:01:00.000Z",
        outcome: "succeeded",
        nodeId: "local",
        claimFence: "fence-1",
        attemptIndex: 0,
        dispatchId: "dispatch-1",
        runtimeSessionId: "session-1",
      },
    },
  };
  const events: CanonicalEventV1[] = [
    compileScheduleRunEvent({
      schedule: settled,
      type: "schedule_run_settled",
      actor,
      source: "local",
      opId: "op-sched-1",
      eventId: "ev-sched-1",
      workspaceRevision: 2,
      occurredAt: "2026-11-25T01:01:00.000Z",
      currentDocumentBlobSha256: null,
    }).event,
  ];
  const projection = {
    getEntity: (kind: string, id: string) =>
      kind === "schedule" && id === base.scheduleId ? { id, value: settled, workspaceRevision: 2 } : null,
    listEntities: (kind: string) =>
      kind === "schedule"
        ? [{ id: base.scheduleId, value: settled, workspaceRevision: 2 }]
        : kind === "agent"
          ? [
              {
                id: "auditor",
                value: {
                  schema: "agent-declaration/v1",
                  id: "auditor",
                  name: "Auditor",
                  instructions: "Audit.",
                  runtimes: [{ type: "codex" }],
                },
                workspaceRevision: 1,
              },
            ]
          : [],
    readTaskStatuses: () => ({ status: "ready" as const, watermark: 2, sourceRevision: 2 }),
    readScheduleEvents: () => ({ status: "ready" as const, events, watermark: 2, sourceRevision: 2 }),
    readScheduleOutputEvents: () => [],
    readRuntimeSession: (id: string) =>
      id === "session-1" ? { resultRef: reportRef, runtimeSessionId: id, definitionSnapshotRef: "" } : null,
    readRuntimeDispatch: () => null,
  };

  const gui = readSchedulesGui({
    mode: "remote-center",
    repoId: "cloud-repo",
    now: () => "2026-11-25T01:30:00.000Z",
    projection: projection as never,
    ports: {
      admitAction: (kind) =>
        kind === "schedule-run-now"
          ? scheduleActionFacet(false, "repo_mode_requires_center_ingress")
          : scheduleActionFacet(true, null),
      runtimeInstances: () => [],
      defaultBackupRetention: { keepDays: 3, keepMonthly: true },
    },
  });
  assert.equal(gui.ok, true);
  assert.equal(gui.schedules.length, 1);
  assert.equal(gui.schedules[0]?.state, "armed");

  assert.deepEqual(scheduleRunReportRefs(projection, base.scheduleId, 10), [reportRef]);
  const runs = readScheduleRuns(
    {
      projection,
      store: { readContentBlob: (sha) => (sha === reportSha ? Buffer.from(reportText) : null) },
    },
    base.scheduleId,
    10,
  );
  assert.equal(runs.ok, true);
  assert.equal(runs.runs.length, 1);
  assert.equal(runs.runs[0]?.reportText, reportText);
});
