// Center-side task lease broker: adjudicates fleet task commands against the
// per-task ownership record, runs the FIFO wait queue, and reaps orphaned
// leases. The canonical ledger's lease events remain the single ownership
// record; this broker persists only coordination state (grant mirror, wait
// queue, executed-opId receipt ring) under the fleet state root.
//
// Recovery contract (adversarial round): the domain lease is the authority and
// the mirror is repairable. Whenever adjudication or the reaper observes a
// domain lease whose mirror row is missing or diverged, the row is REBUILT
// from the domain lease's assignment attribution (roster lookup) instead of
// being dropped; a failed orphan release keeps the row for the next sweep.
// Every grant decision and its domain write runs behind a per-task gate, so an
// asynchronous domain probe can never act on a stale mirror snapshot and a
// concurrent first-grab queues instead of racing the winner.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { consumeKnownError, sha256Text, stableStringify } from "../../kernel/src/index.ts";
import type { DaemonHost } from "./daemon-host.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";
import { FLEET_TASK_COMMAND_KINDS, type FleetFrameV1, type FleetTaskAction } from "./fleet/contract.ts";
import type { FleetAssignmentRecord } from "./fleet/center.ts";
import { writeFileDurably } from "./durable-file.ts";

export interface FleetLeaseTimers {
  readonly orphanTimeoutMs: number;
  readonly reapIntervalMs: number;
  readonly maxWaitMs: number;
  readonly maxQueuePerTask: number;
}
export function fleetLeaseTimers(env: NodeJS.ProcessEnv = process.env): FleetLeaseTimers {
  const positive = (name: string, fallback: number): number => {
    const raw = Number(env[name]);
    return Number.isSafeInteger(raw) && raw > 0 ? raw : fallback;
  };
  return {
    orphanTimeoutMs: positive("HARNESS_LEASE_ORPHAN_TIMEOUT", 24 * 60 * 60 * 1_000),
    reapIntervalMs: positive("HARNESS_LEASE_REAP_INTERVAL_MS", 60_000),
    maxWaitMs: positive("HARNESS_TASK_WAIT_TIMEOUT_MS", 30 * 60 * 1_000),
    maxQueuePerTask: positive("HARNESS_TASK_WAIT_MAX_PER_TASK", 100),
  };
}
export type FleetTaskCommandFrame = Extract<FleetFrameV1, { schema: "fleet.task.command/v1" }>;
export type FleetTaskResultFields = Omit<
  Extract<FleetFrameV1, { schema: "fleet.task.result/v1" }>,
  "schema" | "messageId" | "inReplyTo"
>;
export interface FleetLeaseBroker {
  readonly handleTaskCommand: (
    nodeId: string,
    frame: FleetTaskCommandFrame,
    clientGone: () => boolean,
  ) => Promise<FleetTaskResultFields>;
  readonly status: () => {
    readonly leases: readonly {
      readonly repoId: string;
      readonly taskId: string;
      readonly assignmentId: string;
      readonly nodeId: string;
      readonly executionId: string | null;
      readonly acquiredAt: string;
      readonly expiresAt: string;
    }[];
    readonly queue: readonly {
      readonly repoId: string;
      readonly taskId: string;
      readonly assignmentId: string;
      readonly opId: string;
      readonly seq: number;
      readonly enqueuedAt: string;
      readonly deadlineAt: string;
    }[];
  };
  readonly reapOnce: () => Promise<void>;
  readonly close: () => void;
}
type LeaseRow = {
  readonly assignment: FleetAssignmentRecord;
  readonly executionId: string | null;
  readonly expiresAt: string;
  readonly acquiredAt: string;
};
// A queued command keeps the task-document bundle it arrived with, so a later
// grant re-executes the same combined push (same opId digest) rather than a
// bare transition that would silently drop the carried documents.
type WaitItem = {
  readonly opId: string;
  readonly seq: number;
  readonly assignment: FleetAssignmentRecord;
  readonly action: FleetTaskAction;
  readonly docs: FleetTaskDocs | null;
  readonly enqueuedAt: string;
  readonly deadlineAt: string;
};
export interface FleetTaskDocs {
  readonly docChanges:
    | readonly {
        readonly path: string;
        readonly baseBlobSha256: string | null;
        readonly policyId: string;
        readonly candidate: {
          readonly ref: string;
          readonly sha256: string;
          readonly size: number;
          readonly mediaType: string;
        };
      }[]
    | null;
  readonly mirrorBaseCut: { readonly revision: number; readonly headDigest: string } | null;
}
type BrokerState = {
  seq: number;
  leases: Record<string, LeaseRow>;
  queue: Record<string, readonly WaitItem[]>;
  receipts: Record<
    string,
    {
      readonly digest: string;
      readonly outcome: "applied" | "op_rejected";
      readonly code: string | null;
      readonly revision: number | null;
      readonly receipt: Readonly<Record<string, unknown>> | null;
      readonly at: string;
    }
  >;
};
type DomainLease = {
  readonly executionId: string;
  readonly sourceJson: string;
  readonly phase: string;
  readonly expiresAt: string;
  readonly assignmentId: string | null;
};
type DomainProbe =
  | { readonly available: true; readonly lease: DomainLease | null }
  | { readonly available: false; readonly lease: null };
type ParkRegistration = {
  readonly settle: (result: FleetTaskResultFields) => void;
  readonly disconnect: () => void;
  readonly clientGone: () => boolean;
};
type TaskDisposition = { readonly result: FleetTaskResultFields } | { readonly parked: Promise<FleetTaskResultFields> };
const RECEIPT_RING = 512;

export function openFleetLeaseBroker(options: {
  readonly stateRoot: string;
  readonly host: Pick<DaemonHost, "run">;
  readonly resolveAssignment: (
    assignmentId: string,
  ) => FleetAssignmentRecord | null | Promise<FleetAssignmentRecord | null>;
  readonly now: () => string;
  readonly env?: NodeJS.ProcessEnv;
  readonly auth?: (assignment: FleetAssignmentRecord) => DaemonAuthenticationContext;
}): FleetLeaseBroker {
  const timers = fleetLeaseTimers(options.env),
    stateFile = path.join(options.stateRoot, "leases.json"),
    state = loadBrokerState(stateFile);
  const parks = new Map<string, ParkRegistration>(),
    inFlight = new Set<string>(),
    pumping = new Set<string>(),
    taskLocks = new Map<string, Promise<void>>();
  const taskKey = (repoId: string, taskId: string): string => `${repoId}|${taskId}`,
    splitKey = (key: string): { readonly repoId: string; readonly taskId: string } => {
      const at = key.indexOf("|");
      return { repoId: key.slice(0, at), taskId: key.slice(at + 1) };
    };
  const persist = (): void => writeDurableJson(stateFile, state),
    auth =
      options.auth ??
      ((assignment: FleetAssignmentRecord) => ({ transportKind: "fleet-tls" as const, assignmentBinding: assignment }));
  const sourceJson = (assignment: FleetAssignmentRecord): string =>
    stableStringify({ kind: "assignment", nodeId: assignment.nodeId, assignmentId: assignment.assignmentId });
  const digestFor = (
    assignment: FleetAssignmentRecord,
    action: FleetTaskAction,
    docs: FleetTaskDocs | null = null,
  ): string => sha256Text(stableStringify({ assignmentId: assignment.assignmentId, action, docs }));
  async function withTaskLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = taskLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      tail = previous.then(() => gate);
    taskLocks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (taskLocks.get(key) === tail) taskLocks.delete(key);
    }
  }
  async function domainLease(repoId: string, taskId: string, assignment: FleetAssignmentRecord): Promise<DomainProbe> {
    try {
      const receipt = await options.host.run(repoId, { kind: "task-show", taskId }, auth(assignment));
      if (receipt.outcome !== "applied") return { available: receipt.code === "task_not_found", lease: null };
      if (typeof receipt.evidence !== "string") return { available: false, lease: null };
      const snapshot = JSON.parse(receipt.evidence) as {
        readonly lease?: {
          readonly executionId?: unknown;
          readonly source?: unknown;
          readonly phase?: unknown;
          readonly expiresAt?: unknown;
        } | null;
      };
      const lease = snapshot.lease;
      if (
        !lease ||
        typeof lease.executionId !== "string" ||
        typeof lease.phase !== "string" ||
        typeof lease.expiresAt !== "string"
      )
        return { available: true, lease: null };
      const source = lease.source as Record<string, unknown> | null;
      return {
        available: true,
        lease: {
          executionId: lease.executionId,
          sourceJson: stableStringify(lease.source),
          phase: lease.phase,
          expiresAt: lease.expiresAt,
          assignmentId:
            source !== null &&
            typeof source === "object" &&
            source.kind === "assignment" &&
            typeof source.assignmentId === "string"
              ? source.assignmentId
              : null,
        },
      };
    } catch (error) {
      consumeKnownError(error);
      return { available: false, lease: null };
    }
  }
  // The domain lease is the authority: rebuild the mirror row from its
  // assignment attribution (roster lookup) whenever the row is missing or
  // diverged. A non-assignment channel (e.g. a local center-side holder) has
  // no fleet binding, so it yields no row — the domain lease still governs
  // adjudication through the probe.
  async function reconcileFromDomain(key: string, domain: DomainLease): Promise<LeaseRow | null> {
    const current = state.leases[key];
    if (
      current &&
      current.assignment.assignmentId === domain.assignmentId &&
      sourceJson(current.assignment) === domain.sourceJson
    ) {
      const row: LeaseRow = {
        assignment: current.assignment,
        executionId: domain.executionId,
        expiresAt: domain.expiresAt,
        acquiredAt: current.acquiredAt,
      };
      state.leases[key] = row;
      persist();
      return row;
    }
    if (!domain.assignmentId) {
      if (current) {
        delete state.leases[key];
        persist();
      }
      return null;
    }
    const assignment = await options.resolveAssignment(domain.assignmentId);
    if (!assignment) {
      if (state.leases[key]) {
        delete state.leases[key];
        persist();
      }
      return null;
    }
    const row: LeaseRow = {
      assignment,
      executionId: domain.executionId,
      expiresAt: domain.expiresAt,
      acquiredAt: options.now(),
    };
    state.leases[key] = row;
    persist();
    return row;
  }
  async function reapRow(key: string, trigger: "lazy" | "reaper"): Promise<boolean> {
    const row = state.leases[key];
    if (!row) return false;
    const { repoId, taskId } = splitKey(key);
    const probe = await domainLease(repoId, taskId, row.assignment),
      domain = probe.lease;
    if (!probe.available) return false;
    if (!domain || domain.phase === "released") {
      delete state.leases[key];
      persist();
      return true;
    }
    if (domain.executionId !== row.executionId || domain.sourceJson !== sourceJson(row.assignment)) {
      await reconcileFromDomain(key, domain);
      return false;
    }
    let receipt;
    try {
      receipt = await options.host.run(
        repoId,
        { kind: "task-release", taskId, reason: `Fleet lease orphan timeout; reaped by the center (${trigger}).` },
        auth(row.assignment),
      );
    } catch (error) {
      consumeKnownError(error);
      return false;
    } // keep the row; the next sweep retries the release
    if (receipt.outcome !== "applied") return false; // keep the row; the domain refused the release
    delete state.leases[key];
    persist();
    return true;
  }
  function reserveProvisional(key: string, assignment: FleetAssignmentRecord, ttlMs: number): void {
    state.leases[key] = {
      assignment,
      executionId: null,
      expiresAt: new Date(Date.parse(options.now()) + ttlMs).toISOString(),
      acquiredAt: options.now(),
    };
  }
  async function pumpQueue(key: string): Promise<void> {
    if (pumping.has(key)) return;
    pumping.add(key);
    try {
      for (;;) {
        const advanced = await withTaskLock(key, async (): Promise<"continue" | "stop"> => {
          if (state.leases[key]) return "stop"; // a live holder stops the pump
          const items = state.queue[key] ?? [],
            head = items[0];
          if (!head) return "stop";
          const park = parks.get(head.opId);
          if (!park) return "stop"; // preserve FIFO position while a disconnected client re-attaches
          if (park.clientGone()) {
            park.disconnect();
            return "stop";
          }
          state.queue[key] = items.slice(1);
          if (head.action.kind === "task-start" && head.action.dryRun !== true)
            reserveProvisional(key, head.assignment, Number(head.action.ttlMs ?? timers.orphanTimeoutMs));
          persist();
          inFlight.add(head.opId);
          let result: FleetTaskResultFields;
          try {
            result = await execute(
              head.assignment,
              head.action,
              head.opId,
              key,
              head.action.kind === "task-start" && head.action.dryRun !== true,
              head.docs,
            );
          } catch (error) {
            consumeKnownError(error);
            result = {
              ...failure(
                "op_rejected",
                "task_execute_failed",
                "The queued command could not be executed; resubmit it.",
              ),
              opId: head.opId,
            };
            if (head.action.kind === "task-start") {
              delete state.leases[key];
              persist();
            }
          } finally {
            inFlight.delete(head.opId);
          }
          resolvePark(head.opId, result);
          return result.outcome === "applied" && head.action.kind === "task-start" ? "stop" : "continue";
        });
        if (advanced === "stop") return;
      }
    } finally {
      pumping.delete(key);
    }
  }
  function resolvePark(opId: string, result: FleetTaskResultFields): void {
    const park = parks.get(opId);
    if (park) park.settle(result);
  }
  function recordReceipt(
    opId: string,
    digest: string,
    outcome: "applied" | "op_rejected",
    code: string | null,
    revision: number | null,
    receipt: Readonly<Record<string, unknown>> | null,
  ): void {
    state.receipts[opId] = { digest, outcome, code, revision, receipt, at: options.now() };
    for (const stale of Object.keys(state.receipts).slice(
      0,
      Math.max(0, Object.keys(state.receipts).length - RECEIPT_RING),
    ))
      delete state.receipts[stale];
  }
  function receiptPayload(receipt: Readonly<Record<string, unknown>> | null): Readonly<Record<string, unknown>> | null {
    if (!receipt) return null;
    return Buffer.byteLength(stableStringify(receipt)) > 64 * 1_024
      ? { outcome: receipt.outcome, code: receipt.code ?? null, note: "receipt omitted: larger than the frame budget" }
      : receipt;
  }
  function failure(outcome: "op_rejected" | "wait_expired", code: string, nextAction: string): FleetTaskResultFields {
    return {
      outcome,
      opId: "",
      code,
      revision: null,
      receipt: { outcome: "op_rejected", code, nextAction },
      lease: null,
      queuePosition: null,
    };
  }
  async function execute(
    assignment: FleetAssignmentRecord,
    action: FleetTaskAction,
    opId: string,
    key: string | null,
    preReserved = false,
    docs: FleetTaskDocs | null = null,
  ): Promise<FleetTaskResultFields> {
    const digest = digestFor(assignment, action, docs);
    const effective: FleetTaskAction =
      action.kind === "task-start" && action.dryRun !== true && !Number.isSafeInteger(action.ttlMs)
        ? { ...action, ttlMs: timers.orphanTimeoutMs }
        : action;
    const ttlMs = Number(effective.ttlMs ?? timers.orphanTimeoutMs),
      dryRun = action.dryRun === true;
    let reserved = preReserved;
    if (action.kind === "task-start" && !dryRun && key && !reserved) {
      reserveProvisional(key, assignment, ttlMs);
      persist();
      reserved = true;
    }
    // The class-A bundle rides the task action into the cell's serial write
    // queue as one command, so holder, document base, and lifecycle transition
    // are adjudicated together and any conflict voids the whole transition.
    const bundle =
      docs !== null && docs.docChanges !== null && docs.docChanges.length > 0
        ? {
            ...effective,
            docChanges: docs.docChanges,
            ...(docs.mirrorBaseCut !== null ? { mirrorBaseCut: docs.mirrorBaseCut } : {}),
          }
        : effective;
    let receipt: Awaited<ReturnType<Pick<DaemonHost, "run">["run"]>>;
    try {
      receipt = await options.host.run(
        assignment.repoId,
        bundle as Parameters<Pick<DaemonHost, "run">["run"]>[1],
        auth(assignment),
      );
    } catch (error) {
      consumeKnownError(error);
      if (typeof error === "object" && error !== null && "code" in error && error.code === "writer_epoch_stale")
        return {
          outcome: "op_rejected",
          opId,
          code: "writer_epoch_stale",
          revision: null,
          receipt: {
            outcome: "op_rejected",
            code: "writer_epoch_stale",
            nextAction: "Query the receipt or reacquire the current writer epoch before retrying.",
          },
          lease: null,
          queuePosition: null,
        };
      throw error;
    }
    const applied = receipt.outcome === "applied",
      record = receipt as unknown as Record<string, unknown>;
    let lease: FleetTaskResultFields["lease"] = null;
    if (!dryRun && key) {
      const { taskId } = splitKey(key);
      if (reserved) {
        if (applied) {
          state.leases[key] = {
            assignment,
            executionId: typeof record.executionId === "string" ? record.executionId : null,
            expiresAt: new Date(Date.parse(options.now()) + ttlMs).toISOString(),
            acquiredAt: options.now(),
          };
          lease = {
            taskId,
            executionId: state.leases[key]!.executionId,
            assignmentId: assignment.assignmentId,
            expiresAt: state.leases[key]!.expiresAt,
          };
        } else delete state.leases[key];
      } else if (applied && (action.kind === "task-submit" || action.kind === "task-release")) delete state.leases[key];
    }
    recordReceipt(
      opId,
      digest,
      applied ? "applied" : "op_rejected",
      receipt.code ?? null,
      receipt.revision ?? null,
      record,
    );
    persist();
    return {
      outcome: applied ? "applied" : "op_rejected",
      opId,
      code: receipt.code ?? null,
      revision: receipt.revision ?? null,
      receipt: receiptPayload(record),
      lease,
      queuePosition: null,
    };
  }
  async function handleTaskCommand(
    nodeId: string,
    frame: FleetTaskCommandFrame,
    clientGone: () => boolean,
  ): Promise<FleetTaskResultFields> {
    const assignment = await options.resolveAssignment(frame.assignmentId);
    const nowMs = Date.parse(options.now());
    if (
      !assignment ||
      assignment.nodeId !== nodeId ||
      assignment.repoId !== frame.repoId ||
      Date.parse(assignment.expiresAt) <= nowMs
    )
      return {
        ...failure(
          "op_rejected",
          "assignment_rejected",
          "Assignment is absent, expired, or bound to another node or repo.",
        ),
        opId: frame.opId,
      };
    const action = frame.action,
      kind = action.kind;
    if (!(FLEET_TASK_COMMAND_KINDS as readonly string[]).includes(kind))
      return {
        ...failure(
          "op_rejected",
          "task_command_rejected",
          "The fleet task channel accepts task-create, task-start, task-progress-append, task-submit, and task-release only.",
        ),
        opId: frame.opId,
      };
    const actionTaskId = typeof action.taskId === "string" ? action.taskId : null,
      taskId = frame.taskId ?? actionTaskId;
    if (actionTaskId !== null && taskId !== null && actionTaskId !== taskId)
      return {
        ...failure(
          "op_rejected",
          "task_command_rejected",
          "Lease-bound task commands must carry one consistent taskId.",
        ),
        opId: frame.opId,
      };
    const docs =
      frame.docChanges !== null || frame.mirrorBaseCut !== null
        ? { docChanges: frame.docChanges, mirrorBaseCut: frame.mirrorBaseCut }
        : null;
    const digest = digestFor(assignment, action, docs);
    const replay = state.receipts[frame.opId];
    if (replay)
      return replay.digest === digest
        ? {
            outcome: replay.outcome,
            opId: frame.opId,
            code: replay.code,
            revision: replay.revision,
            receipt: replay.receipt,
            lease: null,
            queuePosition: null,
          }
        : {
            ...failure("op_rejected", "op_conflict", "This opId was already used for a different command."),
            opId: frame.opId,
          };
    if (inFlight.has(frame.opId))
      return {
        ...failure(
          "op_rejected",
          "op_in_flight",
          "This opId is currently executing; retry the same command to pick up its receipt.",
        ),
        opId: frame.opId,
      };
    if (kind === "task-create") {
      inFlight.add(frame.opId);
      try {
        return await execute(assignment, action, frame.opId, null);
      } finally {
        inFlight.delete(frame.opId);
      }
    }
    if (taskId === null)
      return {
        ...failure(
          "op_rejected",
          "task_command_rejected",
          "Lease-bound task commands must carry one consistent taskId.",
        ),
        opId: frame.opId,
      };
    const key = taskKey(assignment.repoId, taskId);
    const disposition = await withTaskLock(key, async (): Promise<TaskDisposition> => {
      const queuedElsewhere = Object.entries(state.queue)
        .flatMap(([queuedKey, items]) => items.map((item) => ({ queuedKey, item })))
        .find(({ item }) => item.opId === frame.opId);
      if (queuedElsewhere) {
        if (
          queuedElsewhere.queuedKey !== key ||
          digestFor(queuedElsewhere.item.assignment, queuedElsewhere.item.action, queuedElsewhere.item.docs) !== digest
        )
          return {
            result: {
              ...failure("op_rejected", "op_conflict", "This opId is already queued for a different command."),
              opId: frame.opId,
            },
          };
        if (Date.parse(queuedElsewhere.item.deadlineAt) <= nowMs) {
          state.queue[key] = (state.queue[key] ?? []).filter((item) => item.opId !== frame.opId);
          persist();
        } else return { parked: parkOn(key, queuedElsewhere.item, clientGone) };
      }
      const replayAfterLock = state.receipts[frame.opId];
      if (replayAfterLock)
        return {
          result:
            replayAfterLock.digest === digest
              ? {
                  outcome: replayAfterLock.outcome,
                  opId: frame.opId,
                  code: replayAfterLock.code,
                  revision: replayAfterLock.revision,
                  receipt: replayAfterLock.receipt,
                  lease: null,
                  queuePosition: null,
                }
              : {
                  ...failure("op_rejected", "op_conflict", "This opId was already used for a different command."),
                  opId: frame.opId,
                },
        };
      if (inFlight.has(frame.opId))
        return {
          result: {
            ...failure(
              "op_rejected",
              "op_in_flight",
              "This opId is currently executing; retry the same command to pick up its receipt.",
            ),
            opId: frame.opId,
          },
        };
      inFlight.add(frame.opId);
      try {
        let row: LeaseRow | null = state.leases[key] ?? null;
        if (row && Date.parse(row.expiresAt) <= nowMs) {
          await reapRow(key, "lazy");
          row = state.leases[key] ?? null;
        }
        const probe = await domainLease(assignment.repoId, taskId, assignment),
          domain = probe.lease;
        if (!probe.available && !row)
          return {
            result: {
              ...failure(
                "op_rejected",
                "lease_state_unavailable",
                "The canonical lease could not be read; retry without changing the opId.",
              ),
              opId: frame.opId,
            },
          };
        if (probe.available) {
          if (domain && domain.phase !== "released") {
            if (!row || domain.executionId !== row.executionId || domain.sourceJson !== sourceJson(row.assignment))
              row = await reconcileFromDomain(key, domain);
          } else if (row) {
            delete state.leases[key];
            persist();
            row = null;
          }
          if (row && domain?.phase === "orphaned") {
            await reapRow(key, "lazy");
            row = state.leases[key] ?? null;
          }
        }
        const heldBySelf =
          domain && domain.phase !== "released"
            ? domain.sourceJson === sourceJson(assignment)
            : row !== null && row.assignment.assignmentId === frame.assignmentId;
        const heldByOther =
          domain && domain.phase !== "released"
            ? domain.sourceJson !== sourceJson(assignment)
            : row !== null && !heldBySelf;
        const queueAhead = (state.queue[key] ?? []).length > 0;
        if (!heldBySelf && (heldByOther || queueAhead))
          return {
            parked: enqueue(key, assignment, action, frame.opId, nowMs, waitCap(frame.waitMs), clientGone, docs),
          };
        if (row === null && action.kind === "task-start" && action.dryRun !== true) {
          const effectiveTtl = Number.isSafeInteger(action.ttlMs) ? Number(action.ttlMs) : timers.orphanTimeoutMs;
          reserveProvisional(key, assignment, effectiveTtl);
          persist();
          return { result: await execute(assignment, action, frame.opId, key, true, docs) };
        }
        return { result: await execute(assignment, action, frame.opId, key, false, docs) };
      } finally {
        inFlight.delete(frame.opId);
      }
    });
    void pumpQueue(key);
    return "parked" in disposition ? disposition.parked : disposition.result;
  }
  const waitCap = (waitMs: number): number => Math.max(1, Math.min(waitMs, timers.maxWaitMs));
  function enqueue(
    key: string,
    assignment: FleetAssignmentRecord,
    action: FleetTaskAction,
    opId: string,
    nowMs: number,
    waitMs: number,
    clientGone: () => boolean,
    docs: FleetTaskDocs | null = null,
  ): Promise<FleetTaskResultFields> {
    const items = state.queue[key] ?? [];
    if (items.length >= timers.maxQueuePerTask)
      return Promise.resolve({
        ...failure(
          "op_rejected",
          "wait_queue_full",
          `This task already has ${items.length} waiting commands; retry later.`,
        ),
        opId,
      });
    const item: WaitItem = {
      opId,
      seq: state.seq++,
      assignment,
      action,
      docs,
      enqueuedAt: options.now(),
      deadlineAt: new Date(nowMs + waitMs).toISOString(),
    };
    state.queue[key] = [...items, item];
    persist();
    return parkOn(key, item, clientGone);
  }
  function parkOn(key: string, item: WaitItem, clientGone: () => boolean): Promise<FleetTaskResultFields> {
    const existing = parks.get(item.opId);
    if (existing && !existing.clientGone())
      return Promise.resolve({
        ...failure("op_rejected", "op_in_flight", "This queued opId already has a live response channel."),
        opId: item.opId,
      });
    if (existing) existing.disconnect();
    return new Promise<FleetTaskResultFields>((resolve) => {
      // Ownership guard: a re-attached park registers under the same opId, so
      // this (older) connection's cleanup must never unregister the newer
      // park — only its own registration.
      const releaseSlot = (): void => {
        if (parks.get(item.opId) === registration) parks.delete(item.opId);
      };
      const settle = (result: FleetTaskResultFields): void => {
        releaseSlot();
        clearInterval(gone);
        clearTimeout(deadline);
        resolve(result);
      };
      const disconnect = (): void => {
        settle({
          ...failure(
            "op_rejected",
            "client_disconnected",
            "The waiting client disconnected; the queued command stays persisted until its deadline; re-send the same opId to re-attach.",
          ),
          opId: item.opId,
        });
      };
      const drop = (): void => {
        state.queue[key] = (state.queue[key] ?? []).filter((queued) => queued.opId !== item.opId);
        persist();
        void pumpQueue(key);
      };
      const deadline = setTimeout(
        () => {
          drop();
          settle({
            outcome: "wait_expired",
            opId: item.opId,
            code: "wait_expired",
            revision: null,
            receipt: {
              outcome: "op_rejected",
              code: "wait_expired",
              nextAction:
                "The task stayed held by another collaborator past the wait deadline; resubmit the command to re-enter the same automatic flow.",
            },
            lease: null,
            queuePosition: null,
          });
        },
        Math.max(1, Date.parse(item.deadlineAt) - Date.parse(options.now())),
      );
      // The queue item survives a disconnect so the client can re-attach with
      // the same opId; the parked reply channel is released and the pump skips
      // the head if its client is still gone when the lease frees.
      const gone = setInterval(() => {
        if (clientGone()) disconnect();
      }, 100);
      const registration: ParkRegistration = { settle, disconnect, clientGone };
      parks.set(item.opId, registration);
      deadline.unref?.();
      gone.unref?.();
    });
  }
  async function sweep(): Promise<void> {
    const nowMs = Date.parse(options.now());
    for (const key of Object.keys(state.leases))
      if (Date.parse(state.leases[key]!.expiresAt) <= nowMs && (await withTaskLock(key, () => reapRow(key, "reaper"))))
        void pumpQueue(key);
    let changed = false;
    for (const key of Object.keys(state.queue)) {
      const keep = (state.queue[key] ?? []).filter((item) => Date.parse(item.deadlineAt) > nowMs);
      if (keep.length !== (state.queue[key] ?? []).length) {
        state.queue[key] = keep;
        changed = true;
        void pumpQueue(key);
      }
    }
    if (changed) persist();
  }
  const reaper = setInterval(() => {
    void sweep();
  }, timers.reapIntervalMs);
  reaper.unref?.();
  return {
    handleTaskCommand,
    reapOnce: sweep,
    status: () => ({
      leases: Object.entries(state.leases).map(([key, row]) => ({
        ...splitKey(key),
        assignmentId: row.assignment.assignmentId,
        nodeId: row.assignment.nodeId,
        executionId: row.executionId,
        acquiredAt: row.acquiredAt,
        expiresAt: row.expiresAt,
      })),
      queue: Object.entries(state.queue).flatMap(([key, items]) =>
        items.map((item) => ({
          ...splitKey(key),
          assignmentId: item.assignment.assignmentId,
          opId: item.opId,
          seq: item.seq,
          enqueuedAt: item.enqueuedAt,
          deadlineAt: item.deadlineAt,
        })),
      ),
    }),
    close: () => {
      clearInterval(reaper);
      for (const [opId, park] of [...parks.entries()])
        park.settle({
          ...failure(
            "op_rejected",
            "center_closing",
            "The fleet center is shutting down; resubmit to re-attach to the persisted queue.",
          ),
          opId,
        });
      parks.clear();
    },
  };
}
function loadBrokerState(file: string): BrokerState {
  if (!existsSync(file)) return { seq: 0, leases: {}, queue: {}, receipts: {} };
  const value = JSON.parse(readFileSync(file, "utf8")) as BrokerState & Record<string, unknown>;
  if (
    value.schema !== "fleet-lease-state/v1" ||
    typeof value.seq !== "number" ||
    value.leases === null ||
    typeof value.leases !== "object" ||
    value.queue === null ||
    typeof value.queue !== "object" ||
    value.receipts === null ||
    typeof value.receipts !== "object"
  )
    throw new Error("Fleet lease broker state contains an unrecognized shape");
  return { seq: value.seq, leases: value.leases, queue: value.queue, receipts: value.receipts };
}
function writeDurableJson(file: string, value: unknown): void {
  writeFileDurably(file, `${JSON.stringify({ schema: "fleet-lease-state/v1", ...(value as object) })}\n`);
}
