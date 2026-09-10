// harness-test-tier: integration
// G1 write-cost-scaling gate fixture: builds a ledger of a given size with a realistic mix of
// event kinds, then drives every durable write kind and hot read once through the production
// daemon request path, measuring deterministic cost (SQL rows read, sha256 calls/bytes, git
// subprocess count, file-read bytes) at the point each operation actually executes:
//   - writes and receipt-show execute inside the writer worker thread (instrumented via the
//     `--import` preload g1-writer-probe-import.mjs, mirroring writer-request-cost.integration.test.ts);
//   - task-list/task-show/agenda/workspace-summary are intercepted host-side by the RepoCell
//     proxy (packages/daemon/src/repo-cell-proxy.ts) and are instrumented in this process directly.
// No production hook is added anywhere; every patch lives in g1-cost-probe.mjs.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  compileDecisionWrite,
  compileFactWrite,
  docSyncWritePlan,
  DOC_POLICY_ID,
  makeTaskEventStore,
  REPLAY_TASK_GRAPH,
  sha256Text,
  taskLifecycleWritePlan,
  type DocEventV1,
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

function taskCreatedEvent(revision: number, taskId: string, title: string): TaskCreatedEvent {
  return {
    schema: "task-event/v1",
    eventId: `event-${taskId}`,
    workspaceRevision: revision,
    opId: `op-${taskId}`,
    taskId,
    type: "task_created",
    actor: { principal: { personId: "person-g1-bulk" }, executor: { kind: "agent", id: "g1-bulk" } },
    source: "local",
    occurredAt: "2026-08-11T00:00:00.000Z",
    payload: {
      task: {
        schema: "task/v2",
        taskId,
        title,
        taskClass: "standard",
        status: "planned",
        graph: REPLAY_TASK_GRAPH,
        currentNode: "implementation",
        iteration: 0,
        createdBy: { principal: { personId: "person-g1-bulk" }, executor: { kind: "agent", id: "g1-bulk" } },
        completionGateIds: [],
        presetSnapshotDigest: null,
        pinned: false,
        packageDisposition: "active",
      },
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
): Extract<DecisionEventDraftV1, { readonly type: "decision_proposed" }> {
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
      relations: [],
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
 * (no daemon round trip), then edits a settled authored file so materialization stays dirty
 * through every later write — reproducing the concurrent-edit shape #2409 fixed. */
function seedLedger(
  rootDir: string,
  repoId: string,
  eventCount: number,
  fence: WriterEpochFenceDescriptor,
): { readonly editedPath: string } {
  const store = makeTaskEventStore({
    repoId,
    rootDir,
    writerFence: () => ({ repoId: fence.repoId, holderId: fence.holderId, epoch: fence.epoch }),
  });
  try {
    const taskCount = Math.max(1, Math.floor(eventCount * 0.85)),
      docCount = Math.max(1, Math.floor(eventCount * 0.1)),
      factCount = Math.max(1, eventCount - taskCount - docCount - 2);
    let revision = store.read().revision;
    for (let index = 0; index < taskCount; index += 1) {
      revision += 1;
      const taskId = `g1-bulk-task-${String(index).padStart(6, "0")}`,
        event = taskCreatedEvent(revision, taskId, `G1 bulk task ${index}`);
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
    revision += 1;
    const decisionId = "dec_G1BULK1",
      compiled = compileDecisionWrite({
        event: decisionDraft(decisionId, revision),
        currentDecision: null,
        currentRelations: [],
        currentDocument: null,
      });
    store.append({ event: compiled.event, plan: compiled.plan, blobs: compiled.blobs });
    return { editedPath };
  } finally {
    void store.drain();
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

async function measureWorkerOperation<T>(
  worker: Worker,
  run: () => Promise<T>,
): Promise<{ readonly result: T; readonly counters: Record<string, number> }> {
  await probeControl(worker, "reset");
  const result = await run();
  const counters = (await probeControl(worker, "snapshot")) as Record<string, number>;
  return { result, counters };
}

function assertApplied(label: string, result: unknown): void {
  const outcome = (result as { readonly outcome?: string } | undefined)?.outcome;
  if (outcome !== "applied")
    throw new Error(`G1 ${label} was not applied (outcome=${outcome}): ${JSON.stringify(result)}`);
}

export interface G1ScaleMeasurement {
  readonly eventCount: number;
  readonly counts: Record<string, Record<string, number>>;
  readonly seedMs: number;
  readonly measureMs: number;
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
  const counts: Record<string, Record<string, number>> = {};
  const seedStartedAt = Date.now();
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
    const seeded = seedLedger(repoDir, repoId, eventCount, fence);
    const seedMs = Date.now() - seedStartedAt;

    const measureStartedAt = Date.now();
    const handle = await openProbedSupervisor(repoId, rootDir, "g1-cost-measure", fence);
    try {
      // Warm up materialization on the already-attached probed writer, then dirty the settled
      // authored file with a local edit that must survive every later write in this same
      // attach — the exact shape 944a86ced regressed on. Introducing the edit only after a clean
      // attach (rather than before) matches production: the daemon attaches once and stays warm.
      await handle.supervisor.request("settlePendingMaterialization", "g1 warmup");
      if (seeded.editedPath)
        writeFileSync(
          path.join(repoDir, "harness", seeded.editedPath),
          "G1 local edit kept dirty through every write.\n",
        );

      const taskId = "g1-measure-task";
      const created = await measureWorkerOperation(handle.worker, () =>
        handle.supervisor.request<{ readonly opId: string; readonly packagePath: string }>(
          "run",
          { action: { kind: "task-create", taskId, title: "G1 measured create" } },
          writeBinding,
        ),
      );
      counts["task-create"] = created.counters;
      assertApplied("task-create", created.result);
      const createOpId = created.result.opId,
        packagePath = created.result.packagePath;

      const planPath = `${packagePath}/task_plan.md`;
      mkdirSync(path.dirname(path.join(repoDir, "harness", planPath)), { recursive: true });
      writeFileSync(path.join(repoDir, "harness", planPath), realizedTaskPlan("G1 measured task"));
      const submitted = await measureWorkerOperation(handle.worker, () =>
        handle.supervisor.request("run", { action: { kind: "doc-submit", paths: [planPath] } }, writeBinding),
      );
      counts["doc-submit"] = submitted.counters;
      assertApplied("doc-submit", submitted.result);

      const executionId = "g1-measure-execution";
      const started = await measureWorkerOperation(handle.worker, () =>
        handle.supervisor.request("run", { action: { kind: "task-start", taskId, executionId } }, writeBinding),
      );
      counts["task-start"] = started.counters;
      assertApplied("task-start", started.result);

      const progressed = await measureWorkerOperation(handle.worker, () =>
        handle.supervisor.request(
          "run",
          { action: { kind: "task-progress-append", taskId, text: "G1 measured progress note.", evidence: [] } },
          writeBinding,
        ),
      );
      counts["task-progress-append"] = progressed.counters;
      assertApplied("task-progress-append", progressed.result);

      const recorded = await measureWorkerOperation(handle.worker, () =>
        handle.supervisor.request(
          "run",
          {
            action: {
              kind: "fact-record",
              taskId,
              statement: "G1 measured fact for the cost-scaling gate.",
              evidenceSource: "g1:measure",
              confidence: "high",
              memoryClass: "semantic",
              memoryTags: [],
            },
          },
          writeBinding,
        ),
      );
      counts["fact-record"] = recorded.counters;
      assertApplied("fact-record", recorded.result);

      const decisionPacket = {
        title: "G1 measured decision",
        question: "Does one decision propose without extra cost at scale?",
        riskTier: "medium",
        urgency: "medium",
        vertical: "software/coding",
        preset: "standard-task",
        decisionClass: "ordinary",
        appliesTo: { modules: ["daemon"], productLines: [] },
        chosen: [{ id: "CH1", text: "Measure the propose action directly." }],
        rejected: [{ id: "RJ1", text: "Skip decision coverage.", whyNot: "Decisions are a durable write kind too." }],
        claims: [{ id: "C1", text: "G1 measures decision-propose and one transition.", loadBearing: true }],
        fulfillments: [],
      };
      const proposed = await measureWorkerOperation(handle.worker, () =>
        handle.supervisor.request<{ readonly evidence: string }>(
          "run",
          {
            action: {
              kind: "decision-propose",
              body: realizedDecisionBody("G1 measured decision"),
              jsonInput: JSON.stringify(decisionPacket),
            },
          },
          writeBinding,
        ),
      );
      counts["decision-propose"] = proposed.counters;
      if (!proposed.result.evidence?.startsWith("{"))
        throw new Error(`G1 decision-propose was not applied: ${JSON.stringify(proposed.result)}`);
      const decisionId = (JSON.parse(proposed.result.evidence) as { readonly decisionId: string }).decisionId;

      const accepted = await measureWorkerOperation(handle.worker, () =>
        handle.supervisor.request(
          "run",
          {
            action: {
              kind: "decision-reject",
              decisionId,
              reason: "G1 measured rejection reason for the cost-scaling gate fixture decision.",
            },
          },
          arbiterBinding,
        ),
      );
      counts["decision-reject"] = accepted.counters;
      assertApplied("decision-reject", accepted.result);

      const related = await measureWorkerOperation(handle.worker, () =>
        handle.supervisor.request(
          "run",
          {
            action: {
              kind: "relation-relate",
              sourceRef: `decision/${decisionId}/CH1`,
              targetRef: `task/${taskId}`,
              relationType: "derives",
              rationale: "G1 measured relation for the cost-scaling gate.",
              expectedVersion: 0,
            },
          },
          writeBinding,
        ),
      );
      counts["relation-relate"] = related.counters;
      assertApplied("relation-relate", related.result);

      const shown = await measureWorkerOperation(handle.worker, () =>
        handle.supervisor.request("run", { action: { kind: "receipt-show", opId: createOpId } }, writeBinding),
      );
      counts["receipt-show"] = shown.counters;
      assertApplied("receipt-show", shown.result);
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
      resetCostProbe();
      await readCell.read("repo.tasks.list");
      counts["task-list"] = snapshotCostProbe();

      resetCostProbe();
      await readCell.run({ kind: "task-show", taskId: "g1-measure-task" }, writeBinding);
      counts["task-show"] = snapshotCostProbe();

      resetCostProbe();
      await readCell.read("repo.agenda.read");
      counts["agenda"] = snapshotCostProbe();

      resetCostProbe();
      readCell.workspaceSummary();
      counts["runtime-overview"] = snapshotCostProbe();
    } finally {
      await readCell.close();
    }
    const measureMs = Date.now() - measureStartedAt;
    return { eventCount, counts, seedMs, measureMs };
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

export function g1FixturesDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}
