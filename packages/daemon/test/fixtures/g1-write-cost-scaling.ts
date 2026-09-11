// harness-test-tier: integration
// G1 write-cost-scaling gate fixture: builds a ledger of a given size with a realistic mix of
// event kinds, then drives every durable write kind and hot read twice through the production
// daemon request path (a warm-up call, then the steady-state call the gate judges), measuring
// deterministic cost (SQL rows read, sha256 calls/bytes, git subprocess count, file-read bytes)
// at the point each operation actually executes:
//   - writes and receipt-show execute inside the writer worker thread (instrumented via the
//     `--import` preload g1-writer-probe-import.mjs, mirroring writer-request-cost.integration.test.ts);
//   - task-list/task-show/agenda/workspace-summary are intercepted host-side by the RepoCell
//     proxy (packages/daemon/src/repo-cell-proxy.ts) and are instrumented in this process directly.
// No production hook is added anywhere; every patch lives in g1-cost-probe.mjs.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  compileDecisionWrite,
  compileFactWrite,
  deriveRelationId,
  docSyncWritePlan,
  DOC_POLICY_ID,
  makeTaskEventStore,
  REPLAY_TASK_GRAPH,
  sha256Text,
  taskLifecycleWritePlan,
  type DocEventV1,
  type TaskEventV1,
} from "../../../kernel/src/index.ts";
// These four are internal-only shapes with no public-barrel re-export (kernel/src/index.ts); the
// fixture still needs their exact structural types to hand-build canonically-valid events, so it
// reaches past the barrel the same way packages/daemon/test/decision-surface.test.ts already does
// for readColdRebuildSource.
// eslint-disable-next-line no-restricted-imports
import { DOC_CODEC_ID } from "../../../kernel/src/domain/doc-sync.contract.ts";
// eslint-disable-next-line no-restricted-imports
import type { DecisionEventDraftV1 } from "../../../kernel/src/domain/decision-event.ts";
// eslint-disable-next-line no-restricted-imports
import type { FactEventDraftV1 } from "../../../kernel/src/domain/fact-event.ts";
// eslint-disable-next-line no-restricted-imports
import type { TaskCreatedEvent } from "../../../kernel/src/domain/task-lifecycle.contract.ts";
import { canonicalRoot, workspaceId } from "../../src/protocol/daemon-protocol.contract.ts";
import { openPersistentWriterEpoch, type WriterEpochFenceDescriptor } from "../../src/writer-epoch.ts";
import { openWriterSupervisor } from "../../src/writer-supervisor.ts";
import { openRepoCell } from "../../src/repo-cell.ts";
import { openBootstrappedRepoCell } from "../repo-settings.fixture.ts";
import { withRoleBinding } from "../role-binding.fixtures.ts";
import { initRepo } from "../task-surface.fixtures.ts";
import { realizedDecisionBody, realizedTaskPlan } from "../../../../tools/fixtures/task-plan.mjs";
import { installCostProbe, resetCostProbe, snapshotCostProbe } from "./g1-cost-probe.mjs";

export const G1_METRICS = Object.freeze(["sqlRowsRead", "sha256Calls", "sha256Bytes", "gitProcesses", "fileReadBytes"]);
export const G1_WRITE_OPERATIONS = Object.freeze([
  "task-create",
  "doc-submit",
  "task-start",
  "task-progress-append",
  "fact-record",
  "decision-propose",
  "decision-reject",
  "relation-relate",
  "decision-reckon",
  "receipt-show",
]);
export const G1_READ_OPERATIONS = Object.freeze(["task-list", "task-show", "agenda", "runtime-overview"]);
export const G1_OPERATIONS = Object.freeze([...G1_WRITE_OPERATIONS, ...G1_READ_OPERATIONS]);

const actor = {
  principal: { personId: "person-g1-cost" },
  executor: { kind: "agent" as const, id: "g1-cost-scaling" },
};
const writeBinding = withRoleBinding({ actor, source: "local" as const }, "repo-write");
// A decision's proposer cannot also accept it; the arbiter binding must be a distinct actor.
const arbiterActor = {
  principal: { personId: "person-g1-arbiter" },
  executor: { kind: "agent" as const, id: "g1-cost-arbiter" },
};
const arbiterBinding = withRoleBinding({ actor: arbiterActor, source: "local" as const }, "arbiter");
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function factIdFor(index: number): string {
  let value = index + 1,
    code = "";
  for (let position = 0; position < 8; position += 1) {
    code = CROCKFORD[value % CROCKFORD.length] + code;
    value = Math.floor(value / CROCKFORD.length);
  }
  return `F-${code}`;
}

const bulkActor = { principal: { personId: "person-g1-bulk" }, executor: { kind: "agent" as const, id: "g1-bulk" } };

function bulkTask(taskId: string, title: string, status: "planned" | "cancelled"): TaskCreatedEvent["payload"]["task"] {
  return {
    schema: "task/v2",
    taskId,
    title,
    taskClass: "standard",
    status,
    graph: REPLAY_TASK_GRAPH,
    currentNode: "implementation",
    iteration: 0,
    createdBy: bulkActor,
    completionGateIds: [],
    presetSnapshotDigest: null,
    pinned: false,
    packageDisposition: "active",
  };
}

function taskCreatedEvent(revision: number, taskId: string, title: string): TaskCreatedEvent {
  return {
    schema: "task-event/v1",
    eventId: `event-${taskId}`,
    workspaceRevision: revision,
    opId: `op-${taskId}`,
    taskId,
    type: "task_created",
    actor: bulkActor,
    source: "local",
    occurredAt: "2026-08-11T00:00:00.000Z",
    payload: { task: bulkTask(taskId, title, "planned") },
  };
}

/** A lifecycle transition shaped the way the kernel's cancel transition emits it
 * (task-lifecycle-command-transitions.ts transitionTask): the whole task at its new status. Cancelled
 * rather than blocked: a blocked task occupies a WIP slot, and the measured task-start needs one. */
function taskCancelledEvent(revision: number, taskId: string, title: string): TaskEventV1 {
  return {
    schema: "task-event/v1",
    eventId: `event-${taskId}-cancelled`,
    workspaceRevision: revision,
    opId: `op-${taskId}-cancelled`,
    taskId,
    type: "task_transitioned",
    actor: bulkActor,
    source: "local",
    occurredAt: "2026-08-11T00:00:00.000Z",
    payload: {
      task: bulkTask(taskId, title, "cancelled"),
      mutation: { command: "transition", reason: "G1 bulk lifecycle transition.", fields: ["status"] },
      documentClaims: [],
    },
  };
}

function docWriteBundle(
  store: ReturnType<typeof makeTaskEventStore>,
  body: string,
  revision: number,
  opId: string,
  target: string,
): {
  readonly event: DocEventV1;
  readonly plan: ReturnType<typeof docSyncWritePlan>;
  readonly blobs: readonly unknown[];
} {
  const hash = sha256Text(body),
    value: DocEventV1 = {
      schema: "doc-event/v1",
      eventId: `event-${opId}`,
      workspaceRevision: revision,
      opId,
      type: "documents_written",
      actor: { principal: { personId: "person-g1-bulk" }, executor: { kind: "agent", id: "g1-bulk" } },
      source: "local",
      occurredAt: "2026-08-11T00:00:00.000Z",
      payload: {
        executionId: "execution-g1-bulk",
        baseLedgerSha: store.currentCut(),
        changes: [
          {
            path: target,
            baseBlobSha256: null,
            policyId: DOC_POLICY_ID,
            candidate: { sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown" },
            // additiveProof (doc-sync-regions.ts) assigns a headingless body the "prose/*" region
            // id when there is no prior base region to match against.
            regionProofs: [
              {
                regionId: "prose/*",
                policyId: DOC_POLICY_ID,
                codecId: DOC_CODEC_ID,
                baseSha256: sha256Text(""),
                candidateSha256: hash,
                insertBytes: Buffer.byteLength(body),
              },
            ],
          },
        ],
      },
    };
  return {
    event: value,
    plan: docSyncWritePlan(value),
    blobs: [{ sha256: hash, size: Buffer.byteLength(body), mediaType: "text/markdown", body }],
  };
}

function decisionDraft(
  decisionId: string,
  revision: number,
  taskId: string,
): Extract<DecisionEventDraftV1, { readonly type: "decision_proposed" }> {
  const relation = {
    source: `decision/${decisionId}/CH1`,
    target: `task/${taskId}`,
    type: "derives" as const,
    direction: "directed" as const,
  };
  return {
    schema: "decision-event/v1",
    eventId: `event-${decisionId}`,
    workspaceRevision: revision,
    opId: `op-${decisionId}`,
    decisionId,
    type: "decision_proposed",
    actor: { principal: { personId: "person-g1-bulk" }, executor: null },
    source: "local",
    occurredAt: "2026-08-11T00:00:00.000Z",
    payload: {
      title: `G1 bulk decision ${decisionId}`,
      question: "Does the write cost stay flat as the ledger grows?",
      riskTier: "medium",
      urgency: "medium",
      vertical: "software/coding",
      preset: "standard-task",
      appliesTo: { modules: ["daemon"], productLines: [] },
      decisionClass: "ordinary",
      chosen: [{ id: "CH1", text: "Measure deterministic cost at two scales." }],
      rejected: [{ id: "RJ1", text: "Trust wall-clock alone.", whyNot: "Shared runners make it noisy." }],
      body: `\n# G1 bulk decision ${decisionId}\n\nFixture decision seeded for the G1 cost-scaling ledger.\n`,
      claims: [{ id: "C1", text: "The fixture ledger carries a real decision with a claim.", loadBearing: true }],
      fulfillments: [],
      relations: [
        {
          ...relation,
          relation_id: deriveRelationId(relation),
          strength: "strong",
          origin: "declared",
          rationale: "G1 bulk decision derives one bulk task.",
          state: "active",
        },
      ],
      provenance: [
        {
          runtime: "unavailable" as const,
          sessionId: null,
          transcriptReachability: "unavailable" as const,
          boundAt: "2026-08-11T00:00:00.000Z",
        },
      ],
    },
  };
}

function factDraft(index: number, revision: number): FactEventDraftV1 {
  return {
    schema: "fact-event/v1",
    eventId: `event-fact-${index}`,
    workspaceRevision: revision,
    opId: `op-fact-${index}`,
    factId: factIdFor(index),
    type: "fact_recorded",
    actor: { principal: { personId: "person-g1-bulk" }, executor: { kind: "agent", id: "g1-bulk" } },
    source: "local",
    occurredAt: "2026-08-11T00:00:00.000Z",
    payload: {
      statement: `G1 bulk fact ${index} observed for the cost-scaling ledger.`,
      evidenceSource: "g1:bulk-fixture",
      observedAt: "2026-08-11T00:00:00.000Z",
      confidence: "high",
      memoryClass: "semantic",
      memoryTags: [],
      provenance: [
        {
          runtime: "unavailable",
          sessionId: null,
          transcriptReachability: "unavailable",
          boundAt: "2026-08-11T00:00:00.000Z",
        },
      ],
    },
  } as FactEventDraftV1;
}

/** Bulk-seeds a ledger to roughly `eventCount` events via direct, canonically-validated appends
 * (no daemon round trip) and waits for its follower to publish them, so the measuring writer
 * attaches to a fully settled Git and worktree. Every seeded kind grows with the ledger, so a cost
 * that scans tasks, lifecycle transitions, documents, facts, decisions, claims or relations shows up. */
async function seedLedger(
  rootDir: string,
  repoId: string,
  eventCount: number,
  fence: WriterEpochFenceDescriptor,
): Promise<{ readonly editedPath: string }> {
  const store = makeTaskEventStore({
    repoId,
    rootDir,
    writerFence: () => ({ repoId: fence.repoId, holderId: fence.holderId, epoch: fence.epoch }),
  });
  try {
    const taskCount = Math.max(1, Math.floor(eventCount * 0.7)),
      cancelledCount = Math.floor(eventCount * 0.1),
      docCount = Math.max(1, Math.floor(eventCount * 0.1)),
      decisionCount = Math.max(1, Math.floor(eventCount * 0.02)),
      factCount = Math.max(1, eventCount - taskCount - cancelledCount - docCount - decisionCount),
      bulkTaskId = (index: number) => `g1-bulk-task-${String(index).padStart(6, "0")}`;
    let revision = store.read().revision;
    for (let index = 0; index < taskCount; index += 1) {
      revision += 1;
      const event = taskCreatedEvent(revision, bulkTaskId(index), `G1 bulk task ${index}`);
      store.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
    }
    for (let index = 0; index < cancelledCount; index += 1) {
      revision += 1;
      const event = taskCancelledEvent(revision, bulkTaskId(index), `G1 bulk task ${index}`);
      store.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
    }
    let editedPath = "";
    for (let index = 0; index < docCount; index += 1) {
      revision += 1;
      const target = `context/g1-bulk-doc-${String(index).padStart(6, "0")}.md`,
        // A single-line body keeps additiveProof's computed region proofs to one "heading/shared"
        // region, matching the proven docBundle fixture shape (task-event-store.fixtures.ts) that
        // this helper mirrors; a multi-paragraph body splits into more regions than a hand-built
        // proof can match.
        body = `G1 bulk document ${index} filler prose for the cost-scaling ledger.\n`,
        { event, plan, blobs } = docWriteBundle(store, body, revision, `op-g1-bulk-doc-${index}`, target);
      store.append({ event, plan, blobs });
      if (index === 0) editedPath = target;
    }
    for (let index = 0; index < factCount; index += 1) {
      revision += 1;
      const compiled = compileFactWrite({ event: factDraft(index, revision) });
      store.append({ event: compiled.event, plan: compiled.plan, blobs: compiled.blobs });
    }
    for (let index = 0; index < decisionCount; index += 1) {
      revision += 1;
      const compiled = compileDecisionWrite({
        event: decisionDraft(`dec_G1BULK${String(index).padStart(6, "0")}`, revision, bulkTaskId(index)),
        currentDecision: null,
        currentRelations: [],
        currentDocument: null,
      });
      store.append({ event: compiled.event, plan: compiled.plan, blobs: compiled.blobs });
    }
    return { editedPath };
  } finally {
    await store.drain();
  }
}

interface RequestHandle {
  readonly supervisor: Awaited<ReturnType<typeof openWriterSupervisor>>;
  readonly worker: Worker;
}

async function openProbedSupervisor(
  repoId: string,
  rootDir: string,
  ownerId: string,
  fence: WriterEpochFenceDescriptor,
): Promise<RequestHandle> {
  const probeUrl = new URL("./g1-writer-probe-import.mjs", import.meta.url).href;
  let capturedWorker: Worker | undefined;
  const supervisor = await openWriterSupervisor(
    { repoId: repoId as never, rootDir: rootDir as never, ownerId, defaultWriterEpochFence: fence },
    {
      createWorker: (url, options) => {
        const worker = new Worker(url, { ...options, execArgv: [...options.execArgv, "--import", probeUrl] });
        capturedWorker = worker;
        return worker;
      },
    },
  );
  if (!capturedWorker) throw new Error("G1 probed worker was not captured");
  return { supervisor, worker: capturedWorker };
}

function probeControl(worker: Worker, command: "reset" | "snapshot"): Promise<Record<string, number> | void> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`G1 probe ${command} timed out`)), 10_000);
    const onMessage = (message: unknown) => {
      const value = message as {
        readonly schema?: string;
        readonly requestId?: string;
        readonly counters?: Record<string, number>;
      };
      if (value?.requestId !== requestId) return;
      if (value.schema === "g1-cost-probe-ack/v1" || value.schema === "g1-cost-probe-result/v1") {
        clearTimeout(timer);
        worker.off("message", onMessage);
        resolve(value.counters);
      }
    };
    worker.on("message", onMessage);
    worker.postMessage({ schema: "g1-cost-probe-control/v1", command, requestId });
  });
}

type Measure = (run: () => Promise<unknown>) => Promise<{ readonly result: unknown; readonly counters: Counters }>;
type Counters = Record<string, number>;

// The worker snapshots after the follower settlement the request queued (g1-writer-probe-import.mjs),
// so a write's window is the request plus the Git/worktree publication it triggered.
function writerMeasure(worker: Worker): Measure {
  return async (run) => {
    await probeControl(worker, "reset");
    const result = await run();
    const counters = (await probeControl(worker, "snapshot")) as Counters;
    return { result, counters };
  };
}

// Host-side reads run synchronously inside the proxy call, so the window closes with the call.
const hostMeasure: Measure = async (run) => {
  resetCostProbe();
  const result = await run();
  return { result, counters: snapshotCostProbe() };
};

function assertApplied(label: string, result: unknown): void {
  const outcome = (result as { readonly outcome?: string } | undefined)?.outcome;
  if (outcome !== "applied")
    throw new Error(`G1 ${label} was not applied (outcome=${outcome}): ${JSON.stringify(result)}`);
}

interface Subject {
  readonly taskId: string;
  createOpId?: string;
  packagePath?: string;
  decisionId?: string;
}

export interface G1ScaleMeasurement {
  readonly eventCount: number;
  /** Steady-state cost: the second call of each operation, the one the gate judges. */
  readonly counts: Record<string, Counters>;
  /** The first call of each operation, including one-time per-process work; reference only. */
  readonly firstCall: Record<string, Counters>;
}

export async function measureWriteCostScaling(eventCount: number): Promise<G1ScaleMeasurement> {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-g1-cost-")),
    repoDir = path.join(parent, "repo"),
    stateRoot = path.join(parent, "writer-epochs"),
    repoId = workspaceId(`g1-cost-${eventCount}`);
  mkdirSync(repoDir, { recursive: true });
  initRepo(repoDir);
  const rootDir = canonicalRoot(repoDir);
  installCostProbe();
  const counts: Record<string, Counters> = {},
    firstCall: Record<string, Counters> = {},
    // Every operation runs once to warm per-process caches, then once more to be judged: G1
    // budgets the work each call does, not a process's one-time setup.
    subjects: Subject[] = [{ taskId: "g1-warm-task" }, { taskId: "g1-measure-task" }];
  const each = async (
    operation: string,
    measure: Measure,
    run: (subject: Subject) => Promise<unknown>,
    check: (result: unknown, subject: Subject) => void = (result) => assertApplied(operation, result),
  ): Promise<void> => {
    for (const [index, subject] of subjects.entries()) {
      const measured = await measure(() => run(subject));
      check(measured.result, subject);
      (index === 0 ? firstCall : counts)[operation] = measured.counters;
    }
  };
  try {
    const authority = openPersistentWriterEpoch({ stateRoot, holderId: "g1-cost-scaling" }),
      lease = authority.acquire(repoId);
    authority.close();
    const fence: WriterEpochFenceDescriptor = {
      schema: "harness-writer-epoch-fence/v1",
      stateRoot,
      repoId,
      epoch: lease.epoch,
      holderId: lease.holderId,
    };
    // Settings/vertical bootstrap through the real production cell, exactly like
    // writer-request-cost.integration.test.ts; then release it before seeding events directly.
    await (
      await openBootstrappedRepoCell({ repoId, rootDir, ownerId: "g1-cost-seed", defaultWriterEpochFence: fence })
    ).close();
    const seeded = await seedLedger(repoDir, repoId, eventCount, fence);
    // A ledger-owned prose file carries an unsubmitted local edit when the writer attaches, and
    // keeps it through warmup and every measured write: the state a daemon (re)starts into on a
    // live ledger. The follower must leave the edit alone without replaying history around it;
    // 944a86ced did replay it, on every write, once a settlement had met the edit.
    writeFileSync(path.join(repoDir, "harness", seeded.editedPath), "G1 local edit kept dirty through every write.\n");

    const handle = await openProbedSupervisor(repoId, rootDir, "g1-cost-measure", fence),
      measure = writerMeasure(handle.worker);
    try {
      await handle.supervisor.request("settlePendingMaterialization", "g1 warmup");
      const run = (action: Record<string, unknown>, binding = writeBinding) =>
        handle.supervisor.request<{ readonly opId: string; readonly packagePath: string; readonly evidence: string }>(
          "run",
          { action },
          binding,
        );

      await each(
        "task-create",
        measure,
        (subject) => run({ kind: "task-create", taskId: subject.taskId, title: `G1 measured ${subject.taskId}` }),
        (result, subject) => {
          assertApplied("task-create", result);
          const created = result as { readonly opId: string; readonly packagePath: string };
          subject.createOpId = created.opId;
          subject.packagePath = created.packagePath;
        },
      );
      await each("doc-submit", measure, (subject) => {
        const planPath = `${subject.packagePath}/task_plan.md`;
        mkdirSync(path.dirname(path.join(repoDir, "harness", planPath)), { recursive: true });
        writeFileSync(path.join(repoDir, "harness", planPath), realizedTaskPlan(`G1 measured ${subject.taskId}`));
        return run({ kind: "doc-submit", paths: [planPath] });
      });
      await each("task-start", measure, (subject) =>
        run({ kind: "task-start", taskId: subject.taskId, executionId: `${subject.taskId}-execution` }),
      );
      await each("task-progress-append", measure, (subject) =>
        run({ kind: "task-progress-append", taskId: subject.taskId, text: "G1 measured progress note.", evidence: [] }),
      );
      await each("fact-record", measure, (subject) =>
        run({
          kind: "fact-record",
          taskId: subject.taskId,
          statement: `G1 measured fact for ${subject.taskId}.`,
          evidenceSource: "g1:measure",
          confidence: "high",
          memoryClass: "semantic",
          memoryTags: [],
        }),
      );
      await each(
        "decision-propose",
        measure,
        (subject) =>
          run({
            kind: "decision-propose",
            body: realizedDecisionBody(`G1 measured decision for ${subject.taskId}`),
            jsonInput: JSON.stringify({
              title: `G1 measured decision for ${subject.taskId}`,
              question: "Does one decision propose without extra cost at scale?",
              riskTier: "medium",
              urgency: "medium",
              vertical: "software/coding",
              preset: "standard-task",
              decisionClass: "ordinary",
              appliesTo: { modules: ["daemon"], productLines: [] },
              chosen: [{ id: "CH1", text: "Measure the propose action directly." }],
              rejected: [
                { id: "RJ1", text: "Skip decision coverage.", whyNot: "Decisions are a durable write kind too." },
              ],
              claims: [{ id: "C1", text: "G1 measures decision-propose and one transition.", loadBearing: true }],
              fulfillments: [],
            }),
          }),
        (result, subject) => {
          const evidence = (result as { readonly evidence?: string }).evidence;
          if (!evidence?.startsWith("{"))
            throw new Error(`G1 decision-propose was not applied: ${JSON.stringify(result)}`);
          subject.decisionId = (JSON.parse(evidence) as { readonly decisionId: string }).decisionId;
        },
      );
      await each("decision-reject", measure, (subject) =>
        run(
          {
            kind: "decision-reject",
            decisionId: subject.decisionId,
            reason: "G1 measured rejection reason for the cost-scaling gate fixture decision.",
          },
          arbiterBinding,
        ),
      );
      await each("relation-relate", measure, (subject) =>
        run({
          kind: "relation-relate",
          sourceRef: `decision/${subject.decisionId}/CH1`,
          targetRef: `task/${subject.taskId}`,
          relationType: "derives",
          rationale: "G1 measured relation for the cost-scaling gate.",
          expectedVersion: 0,
        }),
      );
      await each("decision-reckon", measure, (subject) =>
        run({ kind: "decision-reckon", decisionId: subject.decisionId, taskId: subject.taskId }),
      );
      await each("receipt-show", measure, (subject) => run({ kind: "receipt-show", opId: subject.createOpId }));
    } finally {
      await handle.supervisor.close();
    }

    const readCell = await openRepoCell({
      repoId: repoId as never,
      rootDir: rootDir as never,
      ownerId: "g1-cost-read",
      defaultWriterEpochFence: fence,
    });
    try {
      // List reads are judged at a page the 200-event ledger already fills in every bucket (it seeds
      // 120 planned tasks and 4 proposed decisions), so both scales return the same full page and
      // any row growth is work outside it. An unbounded full-set read scales with its result by
      // definition and is not what G1 budgets.
      const limit = 3;
      await each("task-list", hostMeasure, () => readCell.run({ kind: "task-list", limit }, writeBinding));
      await each("task-show", hostMeasure, (subject) =>
        readCell.run({ kind: "task-show", taskId: subject.taskId }, writeBinding),
      );
      await each(
        "agenda",
        hostMeasure,
        () => readCell.read("repo.agenda.read", { limit }),
        () => undefined,
      );
      await each(
        "runtime-overview",
        hostMeasure,
        async () => readCell.workspaceSummary(),
        () => undefined,
      );
    } finally {
      await readCell.close();
    }
    return { eventCount, counts, firstCall };
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}
