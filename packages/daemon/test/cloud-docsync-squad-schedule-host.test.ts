// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  createScheduleV1,
  RAW_ARTIFACT_POLICY_ID,
  sha256Bytes,
  sha256Text,
  type CanonicalEventV1,
  type CanonicalSquadRun,
  type ScheduleV1,
  type TaskV2,
} from "@harness-anything/kernel";
import { compileScheduleRunEvent } from "@harness-anything/kernel/internal/domain/schedule-event";
import { createCloudQueryHost } from "../src/fleet-sync/cloud-query-host.ts";
import { validateScheduleRuns } from "../src/daemon-host/protocol/schedule-runs-contract.ts";
import { validateSchedulesList } from "../src/daemon-host/protocol/schedules-contract.ts";
import { validateSquadRunRead, validateSquadRunsList } from "../src/daemon-host/squad-run-contract.ts";
import type { PgTaskQueryReader } from "../../storage/src/pg/pg-task-query-reader.ts";

const actor = { principal: { personId: "person_owner" }, executor: null } as const;

function makeFixtureHost(authOutcome: "allowed" | "denied" | "unauthenticated" = "allowed") {
  const textBody = "# Cloud Doc\nStateless content\n";
  const textSha = sha256Text(textBody);
  const binBytes = Uint8Array.from([1, 2, 3, 4]);
  const binSha = sha256Bytes(binBytes);
  const leaderResult = '{"schema":"runtime-batch/v1","dispatches":[]}';
  const leaderResultSha = sha256Text(leaderResult);
  const scheduleReport = "Nightly check clean.";
  const scheduleReportSha = sha256Text(scheduleReport);
  const runId = "squad_0123456789abcdef01234567";
  const scheduleId = "cloud-nightly";

  const baseSchedule = createScheduleV1({
    scheduleId,
    name: "Cloud Nightly",
    mode: "detect",
    spec: {
      trigger: { kind: "interval", everyMs: 1_800_000, anchorAt: "2026-11-25T00:00:00.000Z" },
      target: { kind: "agent", agentId: "cloud-agent" },
      mission: "Check cloud health.",
    },
    actor,
    occurredAt: "2026-11-25T00:00:00.000Z",
  });
  const settledSchedule: ScheduleV1 = {
    ...baseSchedule,
    status: {
      ...baseSchedule.status,
      automaticEvaluatedThrough: "2026-11-25T01:00:00.000Z",
      activeRun: null,
      lastRun: {
        occurrenceId: "occ-cloud-1",
        scheduledFor: "2026-11-25T01:00:00.000Z",
        endedAt: "2026-11-25T01:02:00.000Z",
        outcome: "succeeded",
        nodeId: "local",
        claimFence: "fence-cloud-1",
        attemptIndex: 0,
        dispatchId: "dispatch-sched-1",
        runtimeSessionId: "session-sched-1",
      },
    },
  };
  const scheduleEvents: CanonicalEventV1[] = [
    compileScheduleRunEvent({
      schedule: settledSchedule,
      type: "schedule_run_settled",
      actor,
      source: "local",
      opId: "op-cloud-sched-1",
      eventId: "ev-cloud-sched-1",
      workspaceRevision: 12,
      occurredAt: "2026-11-25T01:02:00.000Z",
      currentDocumentBlobSha256: null,
    }).event,
  ];

  const squadRun: CanonicalSquadRun = {
    schema: "squad-run-observation/v1",
    squadRunId: runId,
    squadId: "cloud-squad",
    ownerDispatchId: "dispatch_0123456789abcdef01234567",
    owner: { source: "local", personId: "person_owner" },
    subject: { kind: "task", taskId: "task_cloud_1", executionId: "exec_cloud_1" },
    mission: "Cloud squad mission",
    phase: "converged",
    error: null,
    currentLeaderRuntimeSessionId: null,
    runRevision: 2,
    acceptedRevision: 12,
    acceptedAt: "2026-11-25T00:30:00.000Z",
    workerCallbackCount: 0,
    pendingLeaderCallbackCount: 0,
    leaderTurns: [
      {
        turnId: "leader-1",
        trigger: { kind: "initial" },
        dispatchId: "dispatch_000000000000000000000001",
        runtimeSessionId: "session-leader-1",
        decision: { kind: "converged" },
      },
    ],
    workerAttempts: [],
  };

  const blobs = new Map<string, Uint8Array>([
    [textSha, Buffer.from(textBody)],
    [binSha, binBytes],
    [leaderResultSha, Buffer.from(leaderResult)],
    [scheduleReportSha, Buffer.from(scheduleReport)],
  ]);

  const docs = new Map([
    [
      "tasks/task_cloud_1-demo/task_plan.md",
      {
        path: "tasks/task_cloud_1-demo/task_plan.md",
        body: textBody,
        blobSha256: textSha,
        size: Buffer.byteLength(textBody),
        mediaType: "text/markdown",
        policyId: "markdown-doc",
        workspaceRevision: 10,
      },
    ],
    [
      "tasks/task_cloud_1-demo/artifacts/raw.bin",
      {
        path: "tasks/task_cloud_1-demo/artifacts/raw.bin",
        body: "",
        blobSha256: binSha,
        size: binBytes.byteLength,
        mediaType: "application/octet-stream",
        policyId: RAW_ARTIFACT_POLICY_ID,
        workspaceRevision: 11,
      },
    ],
  ]);

  const queries = {
    readCut: () => ({ status: "ready" as const, watermark: 12, sourceRevision: 12 }),
    readTaskStatuses: () => ({ status: "ready" as const, watermark: 12, sourceRevision: 12 }),
    read: (taskId: string) => ({
      status: "ready" as const,
      watermark: 12,
      sourceRevision: 12,
      packagePath: taskId === "task_cloud_1" ? "tasks/task_cloud_1-demo" : null,
      snapshot: {
        task:
          taskId === "task_cloud_1"
            ? ({
                taskId: "task_cloud_1",
                taskClass: "standard",
                title: "Cloud task",
                status: "active",
                packageDisposition: "active",
                iteration: 1,
              } as unknown as TaskV2)
            : null,
        executions: [{ executionId: "exec_cloud_1", iteration: 1 }],
        lease: null,
        revision: 12,
      },
    }),
    readDocument: (logical: string) => ({
      status: "ready" as const,
      watermark: 12,
      sourceRevision: 12,
      document: docs.get(logical) ?? null,
    }),
    readDocumentHistory: () => ({ status: "ready" as const, watermark: 12, sourceRevision: 12, document: null }),
    readDocuments: (prefix: string) => ({
      status: "ready" as const,
      watermark: 12,
      sourceRevision: 12,
      documents: [...docs.values()]
        .filter((d) => d.path.startsWith(prefix))
        .map(({ path, blobSha256, size, mediaType }) => ({ path, blobSha256, size, mediaType })),
      page: { nextPath: null },
    }),
    taskIdForDocumentPath: (logical: string) =>
      logical.startsWith("tasks/task_cloud_1-demo/") ? "task_cloud_1" : null,
    readTaskRelationsByTargets: () => ({ rows: [] }),
    currentLease: () => null,
    currentLeaseForExecution: () => null,
    readSquadRuns: () => [{ squadRunId: runId, state: squadRun }],
    readSquadRun: (id: string) => (id === runId ? { squadRunId: runId, state: squadRun } : null),
    readRuntimeSession: (id: string) =>
      id === "session-leader-1"
        ? {
            runtimeSessionId: id,
            outcome: "succeeded",
            lastObservedAt: "2026-11-25T00:31:00.000Z",
            resultRef: `artifact:runtime-result/sha256/${leaderResultSha}`,
            definitionSnapshotRef: "",
          }
        : id === "session-sched-1"
          ? {
              runtimeSessionId: id,
              outcome: "succeeded",
              lastObservedAt: "2026-11-25T01:02:00.000Z",
              resultRef: `artifact:runtime-result/sha256/${scheduleReportSha}`,
              definitionSnapshotRef: "",
            }
          : null,
    readRuntimeDispatch: () => ({
      payload: { startedAt: "2026-11-25T00:30:01.000Z" },
      occurredAt: "2026-11-25T00:30:01.000Z",
    }),
    readRuntimeSessionEventsByType: () => [],
    readDispatchLifecycle: () => ({
      attemptPhase: "closed",
      groupPhase: "closed",
      reservationState: "released",
      displayStatus: "succeeded",
    }),
    getEntity: (kind: string, id: string) =>
      kind === "schedule" && id === scheduleId ? { id, value: settledSchedule, workspaceRevision: 12 } : null,
    listEntities: (kind: string) =>
      kind === "schedule"
        ? [{ id: scheduleId, value: settledSchedule, workspaceRevision: 12 }]
        : kind === "agent"
          ? [
              {
                id: "cloud-agent",
                value: {
                  schema: "agent-declaration/v1",
                  id: "cloud-agent",
                  name: "Cloud Agent",
                  instructions: "Work.",
                  runtimes: [{ type: "codex" }],
                },
                workspaceRevision: 1,
              },
            ]
          : [],
    readScheduleEvents: () => ({ status: "ready" as const, events: scheduleEvents, watermark: 12, sourceRevision: 12 }),
    readScheduleOutputEvents: () => [],
  };

  let inSession = false;
  const fakeReader = {
    path: "memory:cloud-test",
    withSession: <A>(read: (q: never) => A): A => {
      assert.equal(inSession, false, "must not nest projection read sessions");
      inSession = true;
      try {
        return read(queries as never);
      } finally {
        inSession = false;
      }
    },
    executeCanonical: (req: { operation: string; sha256?: string }) => {
      assert.equal(inSession, false, "executeCanonical must run outside withSession");
      if (req.operation === "head") return { revision: 12, opId: "op-12", eventDigest: `sha256:${"a".repeat(64)}` };
      if (req.operation === "content" && req.sha256) return blobs.get(req.sha256) ?? null;
      return null;
    },
  } as unknown as PgTaskQueryReader;

  const host = createCloudQueryHost({
    pool: {} as never,
    authorizer: {
      authorizeRepositoryRead: async () =>
        authOutcome === "allowed" ? { outcome: "allowed", personId: "person_owner" } : { outcome: authOutcome },
    },
    repositories: new Map([["repo", { tenantId: "tenant", projectId: "project", readers: [], policyEpoch: 0 }]]),
    openQueryReader: () => fakeReader,
    maxInFlight: 4,
  });

  return { host, textBody, textSha, binBytes, leaderResult, scheduleReport, runId, scheduleId };
}

test("cloud query host serves all 9 DocSync, Squad, and Schedule stateless read routes", async () => {
  const { host, textBody, textSha, binBytes, leaderResult, scheduleReport, runId, scheduleId } = makeFixtureHost();
  const get = (route: string) =>
    host(
      new Request(`http://cloud.local/v1/repositories/repo/${route}`, {
        headers: { authorization: "Bearer valid-token" },
      }),
    );

  // DocSync routes
  const docListRes = await get("doc-list?prefix=tasks/&limit=10");
  assert.equal(docListRes.status, 200);
  const docList = (await docListRes.json()) as { ok: boolean; documents: { path: string }[] };
  assert.equal(docList.ok, true);
  assert.equal(docList.documents.length, 2);

  const docShowRes = await get("doc-show?path=tasks/task_cloud_1-demo/task_plan.md");
  assert.equal(docShowRes.status, 200);
  const docShow = (await docShowRes.json()) as { outcome: string; evidence: string };
  assert.equal(docShow.outcome, "applied");
  assert.equal(docShow.evidence, textBody);

  const docShowRangeRes = await get(
    `doc-show?path=tasks/task_cloud_1-demo/task_plan.md&offset=0&length=11&contentSha256=${textSha}&contentRevision=10`,
  );
  assert.equal(docShowRangeRes.status, 200);
  const docShowRange = (await docShowRangeRes.json()) as { evidence: string };
  assert.equal(Buffer.from(docShowRange.evidence, "base64").toString("utf8"), "# Cloud Doc");

  const docShowConflictRes = await get(
    `doc-show?path=tasks/task_cloud_1-demo/task_plan.md&offset=0&length=11&contentSha256=${"0".repeat(64)}&contentRevision=10`,
  );
  assert.equal(docShowConflictRes.status, 409);

  const taskDocsRes = await get("task-documents?taskId=task_cloud_1");
  assert.equal(taskDocsRes.status, 200);
  const taskDocs = (await taskDocsRes.json()) as { documents: { path: string }[] };
  assert.deepEqual(
    taskDocs.documents.map((d) => d.path),
    ["artifacts/raw.bin", "task_plan.md"],
  );

  const taskDocBinRes = await get("task-document?taskId=task_cloud_1&path=artifacts/raw.bin&view=canonical");
  assert.equal(taskDocBinRes.status, 200);
  const taskDocBin = (await taskDocBinRes.json()) as { source: string; bytes: string };
  assert.equal(taskDocBin.source, "canonical");
  assert.equal(taskDocBin.bytes, Buffer.from(binBytes).toString("base64"));

  // Squad routes
  const squadRunsRes = await get("squad-runs?limit=20");
  assert.equal(squadRunsRes.status, 200);
  const squadRuns = await squadRunsRes.json();
  assert.deepEqual(validateSquadRunsList(squadRuns), []);

  const squadRunRes = await get(`squad-run?squadRunId=${runId}`);
  assert.equal(squadRunRes.status, 200);
  const squadRun = (await squadRunRes.json()) as { run: { leaderTurns: { resultText: string }[] } };
  assert.deepEqual(validateSquadRunRead(squadRun), []);
  assert.equal(squadRun.run.leaderTurns[0]?.resultText, leaderResult);

  const squadStatusRes = await get(`squad-run-status?squadRunId=${runId}`);
  assert.equal(squadStatusRes.status, 200);
  const squadStatus = (await squadStatusRes.json()) as { status: string; exitCode: number };
  assert.equal(squadStatus.status, "converged");
  assert.equal(squadStatus.exitCode, 0);

  // Schedule routes
  const schedulesRes = await get("schedules");
  assert.equal(schedulesRes.status, 200);
  const schedules = await schedulesRes.json();
  assert.deepEqual(validateSchedulesList(schedules), []);

  const scheduleRunsRes = await get(`schedule-runs?scheduleId=${scheduleId}&limit=10`);
  assert.equal(scheduleRunsRes.status, 200);
  const scheduleRuns = (await scheduleRunsRes.json()) as { runs: { reportText: string }[] };
  assert.deepEqual(validateScheduleRuns(scheduleRuns), []);
  assert.equal(scheduleRuns.runs[0]?.reportText, scheduleReport);
});

test("cloud query host enforces G38 bounds, error mapping, and authorization across Doc/Squad/Schedule routes", async () => {
  const { host } = makeFixtureHost("allowed");
  const get = (route: string) =>
    host(
      new Request(`http://cloud.local/v1/repositories/repo/${route}`, {
        headers: { authorization: "Bearer valid-token" },
      }),
    );

  // G38 bounded limit enforcement
  assert.equal((await get("doc-list?limit=501")).status, 400);
  assert.equal((await get("squad-runs?limit=501")).status, 400);
  assert.equal((await get("schedule-runs?scheduleId=cloud-nightly&limit=201")).status, 400);
  assert.equal((await get("doc-show?path=tasks/a/task_plan.md&offset=0&length=65537")).status, 400);

  // 404 / 400 domain error mapping
  assert.equal((await get("squad-run?squadRunId=invalid")).status, 400);
  assert.equal((await get("squad-run?squadRunId=squad_ffffffffffffffffffffffff")).status, 404);
  assert.equal((await get("schedule-runs?scheduleId=missing-schedule")).status, 404);
  assert.equal((await get("task-documents?taskId=task_missing")).status, 404);

  // Authorization denied (403) and unauthenticated (401)
  const denied = makeFixtureHost("denied").host;
  for (const route of ["doc-list", "squad-runs", "schedules", "schedule-runs?scheduleId=cloud-nightly"]) {
    const res = await denied(
      new Request(`http://cloud.local/v1/repositories/repo/${route}`, {
        headers: { authorization: "Bearer denied-token" },
      }),
    );
    assert.equal(res.status, 403, route);
    const noAuth = await denied(new Request(`http://cloud.local/v1/repositories/repo/${route}`));
    assert.equal(noAuth.status, 401, route);
  }
});

test("cloud query host self-heals poisoned reader on readerRoutes and releases readers on close()", async () => {
  let openCount = 0;
  let closeCalls = 0;
  let firstClosed = false;
  const host = createCloudQueryHost({
    pool: {} as never,
    authorizer: {
      authorizeRepositoryRead: async () => ({ outcome: "allowed", personId: "person_owner" }),
    },
    repositories: new Map([["repo", { tenantId: "tenant", projectId: "project", readers: [], policyEpoch: 0 }]]),
    openQueryReader: () => {
      openCount++;
      const attempt = openCount;
      return {
        path: `memory:doc-test-${attempt}`,
        isClosed: () => (attempt === 1 ? firstClosed : false),
        close: () => {
          closeCalls++;
          if (attempt === 1) firstClosed = true;
        },
        withSession: <A>(read: (q: never) => A): A => {
          if (attempt === 1) {
            firstClosed = true;
            throw Object.assign(new Error("PostgreSQL task query worker timed out"), {
              code: "pg_query_worker_timeout",
            });
          }
          return read({
            readDocuments: () => ({
              status: "ready" as const,
              watermark: 1,
              sourceRevision: 1,
              documents: [
                { path: "tasks/t1/task_plan.md", blobSha256: "a".repeat(64), size: 10, mediaType: "text/markdown" },
              ],
              page: { nextPath: null },
            }),
          } as never);
        },
      } as unknown as PgTaskQueryReader;
    },
    maxInFlight: 4,
  });

  const get = () =>
    host(
      new Request("http://cloud.local/v1/repositories/repo/doc-list?limit=10", {
        headers: { authorization: "Bearer valid-token" },
      }),
    );

  const failed = await get();
  assert.equal(failed.status, 504);
  assert.equal(openCount, 1);

  const recovered = await get();
  assert.equal(recovered.status, 200);
  const body = (await recovered.json()) as { ok: boolean; documents: { path: string }[] };
  assert.equal(body.ok, true);
  assert.equal(body.documents.length, 1);
  assert.equal(openCount, 2);

  await host.close();
  assert.ok(closeCalls >= 1, "host.close() must close cached readers");
});
