import assert from "node:assert/strict";
import {
  canonicalLedgerCut,
  createScheduleV1,
  decideDocWrite,
  documentPath,
  RAW_ARTIFACT_MEDIA_TYPE,
  RAW_ARTIFACT_POLICY_ID,
  REPLAY_TASK_GRAPH,
  sha256Bytes,
  sha256Text,
  stableStringify,
  type AgentRuntimeEventV1,
  type CanonicalEventV1,
  type DocByteLength,
  type DocClaimRef,
  type ScheduleV1,
} from "@harness-anything/kernel";
import { compileEntityUpsert } from "@harness-anything/kernel/internal/domain/entity-event-compile.ts";
import { compileScheduleRunEvent } from "@harness-anything/kernel/internal/domain/schedule-event";
import {
  taskBootstrapWritePlan,
  type TaskBootstrapEventV1,
} from "@harness-anything/kernel/internal/domain/task-bootstrap-event.ts";
import { materializePgProjectionEvents } from "../../../storage/src/pg/index.ts";
import { createPgTaskQueryReader, type PgTaskQueryReader } from "../../../storage/src/pg/pg-task-query-reader.ts";
import { makePostgresTaskEventStore } from "../../../storage/src/postgres/index.ts";
import { canonicalEventWritePlan, type CanonicalWriteBundle } from "../../../storage/src/store/task-event-store.ts";
import { createCloudQueryHost } from "../../src/fleet-sync/cloud-query-host.ts";
import { validateScheduleRuns } from "../../src/daemon-host/protocol/schedule-runs-contract.ts";
import { validateSchedulesList } from "../../src/daemon-host/protocol/schedules-contract.ts";
import { validateSquadRunRead, validateSquadRunsList } from "../../src/daemon-host/squad-run-contract.ts";

const actor = { principal: { personId: "person_cloud_owner" }, executor: null } as const;

type PgPool = Parameters<typeof makePostgresTaskEventStore>[0]["pool"];

export async function assertCloudDocSyncSquadSchedulePg(fixture: {
  readonly pool: PgPool;
  readonly connectionString: string;
}): Promise<void> {
  const readers: PgTaskQueryReader[] = [];
  try {
    const repoId = "cloud-slice3-pg";
    const scope = {
      tenantId: "tenant-cloud-slice3",
      projectId: "project-cloud-slice3",
      policyEpoch: 1,
      readers: ["person_cloud_owner"],
    };
    const eventStore = makePostgresTaskEventStore({
      pool: fixture.pool,
      repoId,
      scope,
      project: async (client, input: { readonly revision: number; readonly events: readonly CanonicalEventV1[] }) => {
        await materializePgProjectionEvents(client, scope, input);
      },
    });

    let expectedRevision = 0;
    const appendCanonical = async (bundle: CanonicalWriteBundle) => {
      await eventStore.append(bundle, expectedRevision, { repoId, holderId: "cloud-slice3-seed", epoch: 1 });
      expectedRevision += 1;
    };

    const taskId = "task_cloud_slice3_pg";
    const packagePath = `tasks/${taskId}-stateless-reads`;
    const planPath = `${packagePath}/task_plan.md`;
    const planBody = "# Stateless PG Cloud Plan\n\nVerified directly from PostgreSQL.\n";
    const presetValue = { schema: "preset-snapshot/v1", id: "cloud-slice3" };
    const presetDigest = `sha256:${sha256Text(stableStringify(presetValue))}` as const;
    const presetBody = `${stableStringify({ ...presetValue, digest: presetDigest })}\n`;
    const bootstrapEvent: TaskBootstrapEventV1 = {
      schema: "task-bootstrap-event/v1",
      eventId: "ev-cloud-s3-bootstrap",
      opId: "op-cloud-s3-bootstrap",
      workspaceRevision: 1,
      taskId,
      type: "task_bootstrapped",
      actor,
      source: "local",
      occurredAt: "2026-11-25T00:00:00.000Z",
      payload: {
        task: {
          schema: "task/v2",
          taskId,
          taskClass: "standard",
          title: "Cloud Slice 3 Stateless Read Task",
          status: "planned",
          graph: REPLAY_TASK_GRAPH,
          currentNode: "implementation",
          iteration: 0,
          createdBy: actor,
          completionGateIds: [],
          presetSnapshotDigest: presetDigest,
          pinned: false,
        },
        presetSnapshotClaim: {
          digest: presetDigest,
          sha256: sha256Text(presetBody),
          size: Buffer.byteLength(presetBody),
          mediaType: "application/json",
        },
        initialDocumentClaims: [
          {
            path: planPath,
            sha256: sha256Text(planBody),
            size: Buffer.byteLength(planBody),
            mediaType: "text/markdown",
            owner: "doc-sync",
            policyId: "markdown-body-replaceable/v1",
          },
        ],
      },
    };
    await appendCanonical({
      event: bootstrapEvent,
      plan: taskBootstrapWritePlan(bootstrapEvent),
      blobs: [
        {
          sha256: bootstrapEvent.payload.presetSnapshotClaim.sha256,
          size: bootstrapEvent.payload.presetSnapshotClaim.size,
          mediaType: "application/json",
          body: presetBody,
        },
        {
          sha256: sha256Text(planBody),
          size: Buffer.byteLength(planBody),
          mediaType: "text/markdown",
          body: planBody,
        },
      ],
    });

    // Seed a raw binary artifact + workspace markdown doc in PostgreSQL ha_content_blobs.
    const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
    const pngSha = sha256Bytes(pngBytes);
    const pngPath = `${packagePath}/artifacts/diagram.png`;
    const notesBody = "# Workspace Notes\n\nShared canonical markdown.\n";
    const notesBytes = Buffer.from(notesBody, "utf8");
    const notesSha = sha256Bytes(notesBytes);
    const notesPath = "context/cloud-notes.md";
    const cutAfterBootstrap = canonicalLedgerCut(repoId, await eventStore.readHead());
    const docDecision = decideDocWrite({
      intent: {
        schema: "doc-write-intent/v1",
        baseLedgerSha: cutAfterBootstrap,
        executionId: null,
        changes: [
          {
            path: documentPath(pngPath),
            baseBlobSha256: null,
            candidate: {
              ref: "doc-sync-claims/cloud-s3-png" as DocClaimRef,
              sha256: pngSha,
              size: pngBytes.byteLength as DocByteLength,
              mediaType: RAW_ARTIFACT_MEDIA_TYPE as never,
            },
            policyId: RAW_ARTIFACT_POLICY_ID,
          },
          {
            path: documentPath(notesPath),
            baseBlobSha256: null,
            candidate: {
              ref: "doc-sync-claims/cloud-s3-notes" as DocClaimRef,
              sha256: notesSha,
              size: notesBytes.byteLength as DocByteLength,
              mediaType: "text/markdown",
            },
            policyId: "markdown-body-replaceable/v1",
          },
        ],
      },
      opId: "op-cloud-s3-docs",
      eventId: "ev-cloud-s3-docs",
      actor,
      source: "local",
      occurredAt: "2026-11-25T00:01:00.000Z",
      workspaceRevision: expectedRevision + 1,
      currentLedgerSha: cutAfterBootstrap,
      lease: null,
      documents: [null, null],
      claims: [pngBytes, notesBytes],
      authorizationDecision: null,
    });
    assert.equal(docDecision.accepted, true, `doc seed rejected: ${JSON.stringify(docDecision)}`);
    await appendCanonical({ event: docDecision.event, plan: docDecision.plan, blobs: docDecision.blobs });

    // Seed Agent + Squad declarations.
    await appendCanonical(
      compileEntityUpsert({
        eventId: "ev-cloud-s3-agent",
        opId: "op-cloud-s3-agent",
        workspaceRevision: expectedRevision + 1,
        actor,
        source: "local",
        occurredAt: "2026-11-25T00:02:00.000Z",
        entityKind: "agent",
        entity: {
          schema: "agent-declaration/v1",
          id: "cloud-agent",
          name: "Cloud Agent",
          instructions: "Execute cloud checks.",
          runtimes: [{ type: "codex" }],
        },
      }),
    );
    await appendCanonical(
      compileEntityUpsert({
        eventId: "ev-cloud-s3-squad",
        opId: "op-cloud-s3-squad",
        workspaceRevision: expectedRevision + 1,
        actor,
        source: "local",
        occurredAt: "2026-11-25T00:02:30.000Z",
        entityKind: "squad",
        entity: {
          schema: "squad-declaration/v1",
          id: "cloud-squad",
          name: "Cloud Squad",
          leader: "cloud-agent",
          workers: ["cloud-agent"],
          leaderTurnBudget: 6,
          roster: "# Cloud Squad",
        },
      }),
    );

    // Seed runtime installation + leader session + dispatch + outcome with result blob + squad run observation.
    const squadRunId = "squad_0123456789abcdef01234567";
    const ownerDispatchId = "dispatch_0123456789abcdef01234567";
    const leaderDispatchId = "dispatch_000000000000000000000001";
    const leaderSessionId = "runtime-cloud-leader-1";
    const leaderResultBody = JSON.stringify({
      schema: "runtime-batch/v1",
      summary: "All cloud invariants green.",
      dispatches: [],
    });
    const leaderResultSha = sha256Text(leaderResultBody);
    const scheduleSessionId = "runtime-cloud-sched-1";
    const scheduleReportBody = "Nightly PG schedule succeeded without drift.";
    const scheduleReportSha = sha256Text(scheduleReportBody);

    const runtimeEvents: Array<{
      readonly event: AgentRuntimeEventV1;
      readonly blobs?: CanonicalWriteBundle["blobs"];
    }> = [
      {
        event: {
          schema: "agent-runtime-event/v1",
          type: "runtime_installation_observed",
          eventId: "ev-cloud-s3-install",
          opId: "op-cloud-s3-install",
          workspaceRevision: 0,
          occurredAt: "2026-11-25T00:03:00.000Z",
          actor,
          source: "local",
          payload: {
            installationId: "install-cloud-1",
            kindId: "codex",
            protocolFamily: "codex-compatible",
            version: "1.0.0",
            discoverySource: "wrapper",
            hostRef: "host:cloud",
            capabilities: [],
          },
        },
      },
      {
        event: {
          schema: "agent-runtime-event/v1",
          type: "runtime_session_started",
          eventId: "ev-cloud-s3-leader-start",
          opId: "op-cloud-s3-leader-start",
          workspaceRevision: 0,
          occurredAt: "2026-11-25T00:04:00.000Z",
          actor,
          source: "local",
          payload: {
            runtimeSessionId: leaderSessionId,
            instanceId: "inst-cloud-1",
            installationId: "install-cloud-1",
            kindId: "codex",
            definitionSnapshotRef: "artifact:runtime-definitions/codex/v1",
            taskBinding: { taskId, executionId: "exec-cloud-1" },
            launchGeneration: 1,
            attachable: false,
          },
        },
      },
      {
        event: {
          schema: "agent-runtime-event/v1",
          type: "runtime_dispatch_requested",
          eventId: "ev-cloud-s3-leader-dispatch",
          opId: "op-cloud-s3-leader-dispatch",
          workspaceRevision: 0,
          occurredAt: "2026-11-25T00:04:01.000Z",
          actor,
          source: "local",
          payload: {
            dispatchId: leaderDispatchId,
            dispatchKey: "key-cloud-leader-1",
            runtimeSessionId: leaderSessionId,
            instanceId: "inst-cloud-1",
            installationId: "install-cloud-1",
            kindId: "codex",
            definitionSnapshotRef: "artifact:runtime-definitions/codex/v1",
            definitionSnapshot: {
              schema: "agent-definition-snapshot/v1",
              configVersion: 1,
              instanceId: "inst-cloud-1",
              installationId: "install-cloud-1",
              kindId: "codex",
              providerId: "openai",
              model: "codex-cloud",
              reasoningEffort: null,
              endpointKind: "official",
              baseUrlHash: null,
              authMode: "subscription",
            },
            startedAt: "2026-11-25T00:04:01.000Z",
            taskId,
            executionId: "exec-cloud-1",
            agentId: "cloud-agent",
            squadId: "cloud-squad",
            squadRun: {
              squadRunId,
              squadId: "cloud-squad",
              mission: "Verify stateless PG squad reads",
              leaderAgentId: "cloud-agent",
              subject: { kind: "task", taskId, executionId: "exec-cloud-1" },
            },
            attemptGroupId: "group-cloud-leader-1",
          },
        },
      },
      {
        event: {
          schema: "agent-runtime-event/v1",
          type: "runtime_session_outcome_observed",
          eventId: "ev-cloud-s3-leader-outcome",
          opId: "op-cloud-s3-leader-outcome",
          workspaceRevision: 0,
          occurredAt: "2026-11-25T00:05:00.000Z",
          actor,
          source: "local",
          payload: {
            runtimeSessionId: leaderSessionId,
            dispatchId: leaderDispatchId,
            outcome: "succeeded",
            exitCode: 0,
            endedAt: "2026-11-25T00:05:00.000Z",
            resultRef: `artifact:runtime-result/sha256/${leaderResultSha}`,
            result: {
              sha256: leaderResultSha,
              size: Buffer.byteLength(leaderResultBody),
              mediaType: "text/plain; charset=utf-8",
            },
          },
        },
        blobs: [
          {
            sha256: leaderResultSha,
            size: Buffer.byteLength(leaderResultBody),
            mediaType: "text/plain; charset=utf-8",
            body: leaderResultBody,
          },
        ],
      },
      {
        event: {
          schema: "agent-runtime-event/v1",
          type: "runtime_squad_run_observed",
          eventId: "ev-cloud-s3-squad-observed",
          opId: "op-cloud-s3-squad-observed",
          workspaceRevision: 0,
          occurredAt: "2026-11-25T00:05:05.000Z",
          actor,
          source: "local",
          payload: {
            squadRunId,
            squadId: "cloud-squad",
            leaderAgentId: "cloud-agent",
            ownerDispatchId,
            subject: { kind: "task", taskId, executionId: "exec-cloud-1" },
            mission: "Verify stateless PG squad reads",
            runRevision: 2,
            phase: "converged",
            error: null,
            currentLeaderRuntimeSessionId: null,
            leaderTurns: [
              {
                turnId: "leader-1",
                trigger: { kind: "initial" },
                dispatchId: leaderDispatchId,
                runtimeSessionId: leaderSessionId,
                decision: { kind: "converged" },
              },
            ],
            workerAttempts: [],
            workerCallbackCount: 0,
            pendingLeaderCallbackCount: 0,
            synthesisReportPath: null,
          },
        },
      },
      {
        event: {
          schema: "agent-runtime-event/v1",
          type: "runtime_session_started",
          eventId: "ev-cloud-s3-sched-start",
          opId: "op-cloud-s3-sched-start",
          workspaceRevision: 0,
          occurredAt: "2026-11-25T01:00:00.000Z",
          actor,
          source: "local",
          payload: {
            runtimeSessionId: scheduleSessionId,
            instanceId: "inst-cloud-1",
            installationId: "install-cloud-1",
            kindId: "codex",
            definitionSnapshotRef: "artifact:runtime-definitions/codex/v1",
            launchGeneration: 1,
            attachable: false,
          },
        },
      },
      {
        event: {
          schema: "agent-runtime-event/v1",
          type: "runtime_session_outcome_observed",
          eventId: "ev-cloud-s3-sched-outcome",
          opId: "op-cloud-s3-sched-outcome",
          workspaceRevision: 0,
          occurredAt: "2026-11-25T01:02:00.000Z",
          actor,
          source: "local",
          payload: {
            runtimeSessionId: scheduleSessionId,
            dispatchId: "dispatch-cloud-sched-1",
            outcome: "succeeded",
            exitCode: 0,
            endedAt: "2026-11-25T01:02:00.000Z",
            resultRef: `artifact:runtime-result/sha256/${scheduleReportSha}`,
            result: {
              sha256: scheduleReportSha,
              size: Buffer.byteLength(scheduleReportBody),
              mediaType: "text/plain; charset=utf-8",
            },
          },
        },
        blobs: [
          {
            sha256: scheduleReportSha,
            size: Buffer.byteLength(scheduleReportBody),
            mediaType: "text/plain; charset=utf-8",
            body: scheduleReportBody,
          },
        ],
      },
    ];
    for (const item of runtimeEvents) {
      const event = { ...item.event, workspaceRevision: expectedRevision + 1 } as AgentRuntimeEventV1;
      await appendCanonical({
        event,
        plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId),
        blobs: item.blobs ?? [],
      });
    }

    // Seed Schedule entity + schedule_run_settled event.
    const scheduleId = "cloud-nightly";
    const baseSchedule = createScheduleV1({
      scheduleId,
      name: "Cloud Nightly",
      mode: "detect",
      spec: {
        trigger: { kind: "interval", everyMs: 1_800_000, anchorAt: "2026-11-25T00:00:00.000Z" },
        target: { kind: "agent", agentId: "cloud-agent" },
        mission: "Run nightly cloud check.",
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
          occurrenceId: "occ-pg-1",
          scheduledFor: "2026-11-25T01:00:00.000Z",
          endedAt: "2026-11-25T01:02:00.000Z",
          outcome: "succeeded",
          nodeId: "local",
          claimFence: "fence-pg-1",
          attemptIndex: 0,
          dispatchId: "dispatch-cloud-sched-1",
          runtimeSessionId: scheduleSessionId,
        },
      },
    };
    await appendCanonical(
      compileScheduleRunEvent({
        schedule: settledSchedule,
        type: "schedule_run_settled",
        actor,
        source: "local",
        opId: "op-cloud-s3-sched-settled",
        eventId: "ev-cloud-s3-sched-settled",
        workspaceRevision: expectedRevision + 1,
        occurredAt: "2026-11-25T01:02:00.000Z",
        currentDocumentBlobSha256: null,
      }),
    );

    const host = createCloudQueryHost({
      pool: fixture.pool,
      authorizer: {
        authorizeRepositoryRead: async ({ token }) => {
          if (token === "valid-token") return { outcome: "allowed", personId: "person_cloud_owner" };
          if (token === "denied-token") return { outcome: "denied" };
          return { outcome: "unauthenticated" };
        },
      },
      repositories: new Map([[repoId, scope]]),
      openQueryReader: ({ repoId: targetRepoId, scope: targetScope }) => {
        const reader = createPgTaskQueryReader({
          connectionString: fixture.connectionString,
          scope: targetScope,
          repoId: targetRepoId,
        });
        readers.push(reader);
        return reader;
      },
      maxInFlight: 8,
    });

    const get = (route: string, token = "valid-token") =>
      host(
        new Request(`http://cloud.local/v1/repositories/${repoId}/${route}`, {
          headers: token ? { authorization: `Bearer ${token}` } : {},
        }),
      );

    // 1. DocSync: doc-list, doc-show (text + binary range), task-documents, task-document (canonical + raw + authored-copy)
    const docListRes = await get("doc-list?limit=50");
    assert.equal(docListRes.status, 200);
    const docList = (await docListRes.json()) as { documents: Array<{ path: string }> };
    assert.ok(docList.documents.some((d) => d.path === planPath));
    assert.ok(docList.documents.some((d) => d.path === pngPath));
    assert.ok(docList.documents.some((d) => d.path === notesPath));

    const docShowTextRes = await get(`doc-show?path=${encodeURIComponent(notesPath)}`);
    assert.equal(docShowTextRes.status, 200);
    const docShowText = (await docShowTextRes.json()) as { outcome: string; evidence: string };
    assert.equal(docShowText.outcome, "applied");
    assert.equal(docShowText.evidence, notesBody);

    const docShowRangeRes = await get(`doc-show?path=${encodeURIComponent(notesPath)}&offset=0&length=16`);
    assert.equal(docShowRangeRes.status, 200);
    const docShowRange = (await docShowRangeRes.json()) as {
      outcome: string;
      evidence: string;
      evidenceEncoding: string;
      evidenceOffset: number;
      evidenceSize: number;
      evidenceBlobSha256: string;
      evidenceDone: boolean;
    };
    assert.equal(docShowRange.outcome, "applied");
    assert.equal(docShowRange.evidenceEncoding, "base64");
    assert.equal(Buffer.from(docShowRange.evidence, "base64").toString("utf8"), notesBody.slice(0, 16));
    assert.equal(docShowRange.evidenceOffset, 0);
    assert.equal(docShowRange.evidenceSize, notesBytes.byteLength);
    assert.equal(docShowRange.evidenceBlobSha256, notesSha);
    assert.equal(docShowRange.evidenceDone, false);

    const taskDocsRes = await get(`task-documents?taskId=${taskId}`);
    assert.equal(taskDocsRes.status, 200);
    const taskDocs = (await taskDocsRes.json()) as { documents: Array<{ path: string }> };
    assert.deepEqual(
      taskDocs.documents.map((d) => d.path),
      ["artifacts/diagram.png", "task_plan.md"],
    );

    const taskBinRes = await get(`task-document?taskId=${taskId}&path=artifacts/diagram.png`);
    assert.equal(taskBinRes.status, 200);
    const taskBin = (await taskBinRes.json()) as {
      source: string;
      contentKind: string;
      bytes: string;
      blobSha256: string;
    };
    assert.equal(taskBin.source, "canonical");
    assert.equal(taskBin.contentKind, "binary");
    assert.equal(taskBin.bytes, Buffer.from(pngBytes).toString("base64"));
    assert.equal(taskBin.blobSha256, pngSha);

    const authoredCopyRes = await get(`task-document?taskId=${taskId}&path=task_plan.md&view=authored-copy`);
    assert.equal(authoredCopyRes.status, 200);
    const authoredCopy = (await authoredCopyRes.json()) as { source: string; syncState: string };
    assert.equal(authoredCopy.source, "unobservable");
    assert.equal(authoredCopy.syncState, "unobservable");

    // 2. Squad: squad-runs, squad-run, squad-run-status (with leader result hydrated from PG ha_content_blobs)
    const squadRunsRes = await get("squad-runs?limit=20");
    assert.equal(squadRunsRes.status, 200);
    const squadRuns = (await squadRunsRes.json()) as { runs: Array<{ squadRunId: string }> };
    assert.deepEqual(validateSquadRunsList(squadRuns), []);
    assert.equal(squadRuns.runs.length, 1);
    assert.equal(squadRuns.runs[0]?.squadRunId, squadRunId);

    const squadRunRes = await get(`squad-run?squadRunId=${squadRunId}`);
    assert.equal(squadRunRes.status, 200);
    const squadRunDetail = (await squadRunRes.json()) as {
      run: { squadRunId: string; leaderTurns: Array<{ resultText: string | null }> };
    };
    assert.deepEqual(validateSquadRunRead(squadRunDetail), []);
    assert.equal(squadRunDetail.run.squadRunId, squadRunId);
    assert.equal(squadRunDetail.run.leaderTurns[0]?.resultText, leaderResultBody);

    const squadStatusRes = await get(`squad-run-status?squadRunId=${squadRunId}`);
    assert.equal(squadStatusRes.status, 200);
    const squadStatus = (await squadStatusRes.json()) as {
      status: string;
      phase: string;
      exitCode: number;
      leaderTurns: Array<{ resultText: string | null }>;
    };
    assert.equal(squadStatus.status, "converged");
    assert.equal(squadStatus.phase, "converged");
    assert.equal(squadStatus.exitCode, 0);
    assert.equal(squadStatus.leaderTurns[0]?.resultText, leaderResultBody);

    // 3. Schedule: schedules, schedule-runs (with report hydrated from PG ha_content_blobs)
    const schedulesRes = await get("schedules");
    assert.equal(schedulesRes.status, 200);
    const schedules = (await schedulesRes.json()) as {
      schedules: Array<{ scheduleId: string; actions: { runNow: { available: boolean } } }>;
    };
    assert.deepEqual(validateSchedulesList(schedules), []);
    assert.equal(schedules.schedules.length, 1);
    assert.equal(schedules.schedules[0]?.scheduleId, scheduleId);
    assert.equal(schedules.schedules[0]?.actions.runNow.available, false);

    const scheduleRunsRes = await get(`schedule-runs?scheduleId=${scheduleId}&limit=10`);
    assert.equal(scheduleRunsRes.status, 200);
    const scheduleRuns = (await scheduleRunsRes.json()) as { runs: Array<{ reportText: string | null }> };
    assert.deepEqual(validateScheduleRuns(scheduleRuns), []);
    assert.equal(scheduleRuns.runs.length, 1);
    assert.equal(scheduleRuns.runs[0]?.reportText, scheduleReportBody);

    // 4. Auth & G38 bounded-read enforcement
    assert.equal((await get("doc-list", "")).status, 401);
    assert.equal((await get("schedules", "denied-token")).status, 403);
    assert.equal((await get("doc-list?limit=99999")).status, 400);
    assert.equal((await get("schedule-runs?scheduleId=cloud-nightly&limit=999")).status, 400);
  } finally {
    for (const reader of readers) reader.close();
  }
}
