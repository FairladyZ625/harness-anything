// Center-side task lease broker: adjudicates fleet task commands against the
// per-task ownership record, runs the FIFO wait queue, and reaps orphaned
// leases. The canonical ledger's lease events remain the single ownership
// record; this broker persists only coordination state (grant mirror, wait
// queue, executed-opId receipt ring) under the fleet state root.
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { consumeKnownError, stableStringify } from "../../../kernel/src/index.ts";
import type { DaemonHost } from "../daemon-host.ts";
import { FLEET_TASK_COMMAND_KINDS, type FleetFrameV1, type FleetTaskAction } from "./contract.ts";
import type { FleetAssignmentRecord } from "./center.ts";

export interface FleetLeaseTimers { readonly orphanTimeoutMs: number; readonly reapIntervalMs: number; readonly maxWaitMs: number; readonly maxQueuePerTask: number }
export function fleetLeaseTimers(env: NodeJS.ProcessEnv = process.env): FleetLeaseTimers {
  const positive = (name: string, fallback: number): number => { const raw = Number(env[name]); return Number.isSafeInteger(raw) && raw > 0 ? raw : fallback; };
  return { orphanTimeoutMs: positive("HARNESS_LEASE_ORPHAN_TIMEOUT", 24 * 60 * 60 * 1_000), reapIntervalMs: positive("HARNESS_LEASE_REAP_INTERVAL_MS", 60_000), maxWaitMs: positive("HARNESS_TASK_WAIT_TIMEOUT_MS", 30 * 60_1_000), maxQueuePerTask: positive("HARNESS_TASK_WAIT_MAX_PER_TASK", 100) };
}
export type FleetTaskCommandFrame = Extract<FleetFrameV1, { schema: "fleet.task.command/v1" }>;
export type FleetTaskResultFields = Omit<Extract<FleetFrameV1, { schema: "fleet.task.result/v1" }>, "schema" | "messageId" | "inReplyTo">;
export interface FleetLeaseBroker {
  readonly handleTaskCommand: (nodeId: string, frame: FleetTaskCommandFrame, clientGone: () => boolean) => Promise<FleetTaskResultFields>;
  readonly status: () => { readonly leases: readonly { readonly repoId: string; readonly taskId: string; readonly assignmentId: string; readonly nodeId: string; readonly executionId: string | null; readonly acquiredAt: string; readonly expiresAt: string }[]; readonly queue: readonly { readonly repoId: string; readonly taskId: string; readonly assignmentId: string; readonly opId: string; readonly seq: number; readonly enqueuedAt: string; readonly deadlineAt: string }[] };
  readonly reapOnce: () => Promise<void>;
  readonly close: () => void;
}
type LeaseRow = { readonly assignment: FleetAssignmentRecord; readonly executionId: string | null; readonly expiresAt: string; readonly acquiredAt: string };
type WaitItem = { readonly opId: string; readonly seq: number; readonly assignment: FleetAssignmentRecord; readonly action: FleetTaskAction; readonly enqueuedAt: string; readonly deadlineAt: string };
type BrokerState = { seq: number; leases: Record<string, LeaseRow>; queue: Record<string, readonly WaitItem[]>; receipts: Record<string, { readonly digest: string; readonly outcome: "applied" | "op_rejected"; readonly code: string | null; readonly revision: number | null; readonly receipt: Readonly<Record<string, unknown>> | null; readonly at: string }> };
const RECEIPT_RING = 512;

export function openFleetLeaseBroker(options: { readonly stateRoot: string; readonly host: Pick<DaemonHost, "run">; readonly resolveAssignment: (assignmentId: string) => FleetAssignmentRecord | null | Promise<FleetAssignmentRecord | null>; readonly now: () => string; readonly env?: NodeJS.ProcessEnv }): FleetLeaseBroker {
  const timers = fleetLeaseTimers(options.env), stateFile = path.join(options.stateRoot, "leases.json"), state = loadState(stateFile);
  const parks = new Map<string, (result: FleetTaskResultFields) => void>();
  const taskKey = (repoId: string, taskId: string): string => `${repoId}|${taskId}`, splitKey = (key: string): { readonly repoId: string; readonly taskId: string } => { const at = key.indexOf("|"); return { repoId: key.slice(0, at), taskId: key.slice(at + 1) }; };
  const persist = (): void => writeDurableJson(stateFile, state), auth = (assignment: FleetAssignmentRecord) => ({ transportKind: "fleet-tls" as const, assignmentBinding: assignment });
  const sourceJson = (assignment: FleetAssignmentRecord): string => stableStringify({ kind: "assignment", nodeId: assignment.nodeId, assignmentId: assignment.assignmentId });
  async function domainLease(repoId: string, taskId: string, assignment: FleetAssignmentRecord): Promise<{ readonly executionId: string; readonly sourceJson: string; readonly phase: string; readonly expiresAt: string } | null> {
    try { const receipt = await options.host.run(repoId, { kind: "task-show", taskId }, auth(assignment)); if (receipt.outcome !== "applied" || typeof receipt.evidence !== "string") return null; const snapshot = JSON.parse(receipt.evidence) as { readonly lease?: { readonly executionId?: unknown; readonly source?: unknown; readonly phase?: unknown; readonly expiresAt?: unknown } | null }; const lease = snapshot.lease; return lease && typeof lease.executionId === "string" && typeof lease.phase === "string" && typeof lease.expiresAt === "string" ? { executionId: lease.executionId, sourceJson: stableStringify(lease.source), phase: lease.phase, expiresAt: lease.expiresAt } : null; }
    catch (error) { consumeKnownError(error); return null; }
  }
  async function reapRow(key: string, trigger: "lazy" | "reaper"): Promise<void> {
    const row = state.leases[key]; if (!row) return; const { repoId, taskId } = splitKey(key);
    const domain = await domainLease(repoId, taskId, row.assignment);
    if (domain && domain.executionId === row.executionId && domain.sourceJson === sourceJson(row.assignment)) await options.host.run(repoId, { kind: "task-release", taskId, reason: `Fleet lease orphan timeout; reaped by the center (${trigger}).` }, auth(row.assignment)).catch(consumeKnownError);
    delete state.leases[key]; persist(); void wake(key);
  }
  async function wake(key: string): Promise<void> { const items = state.queue[key] ?? [], head = items[0]; if (!head) return; state.queue[key] = items.slice(1); persist(); try { resolvePark(head.opId, await execute(head.assignment, head.action, head.opId, key)); } catch (error) { consumeKnownError(error); resolvePark(head.opId, { ...failure("op_rejected", "task_execute_failed", "The queued command could not be executed; resubmit it."), opId: head.opId }); } }
  function resolvePark(opId: string, result: FleetTaskResultFields): void { const park = parks.get(opId); if (park) { parks.delete(opId); park(result); } }
  function recordReceipt(opId: string, digest: string, outcome: "applied" | "op_rejected", code: string | null, revision: number | null, receipt: Readonly<Record<string, unknown>> | null): void { state.receipts[opId] = { digest, outcome, code, revision, receipt, at: options.now() }; for (const stale of Object.keys(state.receipts).slice(0, Math.max(0, Object.keys(state.receipts).length - RECEIPT_RING))) delete state.receipts[stale]; }
  function receiptPayload(receipt: Readonly<Record<string, unknown>> | null): Readonly<Record<string, unknown>> | null { if (!receipt) return null; return Buffer.byteLength(stableStringify(receipt)) > 64 * 1_024 ? { outcome: receipt.outcome, code: receipt.code ?? null, note: "receipt omitted: larger than the frame budget" } : receipt; }
  function failure(outcome: "op_rejected" | "wait_expired", code: string, nextAction: string): FleetTaskResultFields { return { outcome, opId: "", code, revision: null, receipt: { outcome: "op_rejected", code, nextAction }, lease: null, queuePosition: null }; }
  async function execute(assignment: FleetAssignmentRecord, action: FleetTaskAction, opId: string, key: string | null): Promise<FleetTaskResultFields> {
    const digest = createHash("sha256").update(stableStringify({ assignmentId: assignment.assignmentId, action })).digest("hex");
    const effective: FleetTaskAction = action.kind === "task-start" && action.dryRun !== true && !Number.isSafeInteger(action.ttlMs) ? { ...action, ttlMs: timers.orphanTimeoutMs } : action;
    const ttlMs = Number(effective.ttlMs ?? timers.orphanTimeoutMs), dryRun = action.dryRun === true;
    let reserved = false;
    if (action.kind === "task-start" && !dryRun && key) { state.leases[key] = { assignment, executionId: null, expiresAt: new Date(Date.parse(options.now()) + ttlMs).toISOString(), acquiredAt: options.now() }; persist(); reserved = true; }
    const receipt = await options.host.run(assignment.repoId, effective as Parameters<Pick<DaemonHost, "run">["run"]>[1], auth(assignment));
    const applied = receipt.outcome === "applied", record = receipt as unknown as Record<string, unknown>;
    let lease: FleetTaskResultFields["lease"] = null;
    if (!dryRun && key) {
      const { taskId } = splitKey(key);
      if (reserved) { if (applied) { state.leases[key] = { assignment, executionId: typeof record.executionId === "string" ? record.executionId : null, expiresAt: new Date(Date.parse(options.now()) + ttlMs).toISOString(), acquiredAt: options.now() }; lease = { taskId, executionId: state.leases[key]!.executionId, assignmentId: assignment.assignmentId, expiresAt: state.leases[key]!.expiresAt }; } else delete state.leases[key]; }
      else if (applied && (action.kind === "task-submit" || action.kind === "task-release")) delete state.leases[key];
    }
    recordReceipt(opId, digest, applied ? "applied" : "op_rejected", receipt.code ?? null, receipt.revision ?? null, record);
    persist();
    if (applied && (action.kind === "task-submit" || action.kind === "task-release") && key) void wake(key);
    return { outcome: applied ? "applied" : "op_rejected", opId, code: receipt.code ?? null, revision: receipt.revision ?? null, receipt: receiptPayload(record), lease, queuePosition: null };
  }
  async function handleTaskCommand(nodeId: string, frame: FleetTaskCommandFrame, clientGone: () => boolean): Promise<FleetTaskResultFields> {
    const assignment = await options.resolveAssignment(frame.assignmentId);
    const nowMs = Date.parse(options.now());
    if (!assignment || assignment.nodeId !== nodeId || assignment.repoId !== frame.repoId || Date.parse(assignment.expiresAt) <= nowMs) return { ...failure("op_rejected", "assignment_rejected", "Assignment is absent, expired, or bound to another node or repo."), opId: frame.opId };
    const action = frame.action, kind = action.kind;
    if (!(FLEET_TASK_COMMAND_KINDS as readonly string[]).includes(kind)) return { ...failure("op_rejected", "task_command_rejected", "The fleet task channel accepts task-create, task-start, task-progress-append, task-submit, and task-release only."), opId: frame.opId };
    const actionTaskId = typeof action.taskId === "string" ? action.taskId : null, taskId = frame.taskId ?? actionTaskId;
    if (taskId === null || actionTaskId !== null && actionTaskId !== taskId) return { ...failure("op_rejected", "task_command_rejected", "Lease-bound task commands must carry one consistent taskId."), opId: frame.opId };
    if (kind === "task-create") return execute(assignment, action, frame.opId, null);
    const key = taskKey(assignment.repoId, taskId), digest = createHash("sha256").update(stableStringify({ assignmentId: assignment.assignmentId, action })).digest("hex"), replay = state.receipts[frame.opId];
    if (replay) return replay.digest === digest ? { outcome: replay.outcome, opId: frame.opId, code: replay.code, revision: replay.revision, receipt: replay.receipt, lease: null, queuePosition: null } : { ...failure("op_rejected", "op_conflict", "This opId was already used for a different command."), opId: frame.opId };
    const queued = (state.queue[key] ?? []).find((item) => item.opId === frame.opId);
    if (queued && Date.parse(queued.deadlineAt) > nowMs) return parkOn(key, queued, clientGone);
    if (queued) { state.queue[key] = (state.queue[key] ?? []).filter((item) => item.opId !== frame.opId); persist(); }
    let row: LeaseRow | null = state.leases[key] ?? null;
    if (row && Date.parse(row.expiresAt) <= nowMs) { await reapRow(key, "lazy"); row = null; }
    const domain = await domainLease(assignment.repoId, taskId, assignment);
    if (row && (!domain || domain.executionId !== row.executionId || domain.sourceJson !== sourceJson(row.assignment))) { delete state.leases[key]; persist(); row = null; }
    const heldByOther = row ? row.assignment.assignmentId !== frame.assignmentId : domain !== null && domain.sourceJson !== sourceJson(assignment);
    if (!heldByOther) return execute(assignment, action, frame.opId, key);
    const items = state.queue[key] ?? [];
    if (items.length >= timers.maxQueuePerTask) return { ...failure("op_rejected", "wait_queue_full", `Task ${taskId} already has ${items.length} waiting commands; retry later.`), opId: frame.opId };
    const waitMs = Math.max(1, Math.min(frame.waitMs, timers.maxWaitMs)), item: WaitItem = { opId: frame.opId, seq: state.seq++, assignment, action, enqueuedAt: options.now(), deadlineAt: new Date(nowMs + waitMs).toISOString() };
    state.queue[key] = [...items, item]; persist();
    return parkOn(key, item, clientGone);
  }
  function parkOn(key: string, item: WaitItem, clientGone: () => boolean): Promise<FleetTaskResultFields> {
    return new Promise<FleetTaskResultFields>((resolve) => {
      const settle = (result: FleetTaskResultFields): void => { parks.delete(item.opId); clearInterval(gone); clearTimeout(deadline); resolve(result); };
      const drop = (): void => { state.queue[key] = (state.queue[key] ?? []).filter((queued) => queued.opId !== item.opId); persist(); };
      const deadline = setTimeout(() => { drop(); settle({ outcome: "wait_expired", opId: item.opId, code: "wait_expired", revision: null, receipt: { outcome: "op_rejected", code: "wait_expired", nextAction: "The task stayed held by another collaborator past the wait deadline; resubmit the command to re-enter the same automatic flow." }, lease: null, queuePosition: null }); }, Math.max(1, Date.parse(item.deadlineAt) - Date.parse(options.now())));
      const gone = setInterval(() => { if (clientGone()) { parks.delete(item.opId); clearInterval(gone); clearTimeout(deadline); resolve({ ...failure("op_rejected", "client_disconnected", "The waiting client disconnected; the queued command stays persisted until its deadline."), opId: item.opId }); } }, 500);
      parks.set(item.opId, settle);
      deadline.unref?.(); gone.unref?.();
    });
  }
  async function sweep(): Promise<void> { const nowMs = Date.parse(options.now()); for (const key of Object.keys(state.leases)) if (Date.parse(state.leases[key]!.expiresAt) <= nowMs) await reapRow(key, "reaper"); let changed = false; for (const key of Object.keys(state.queue)) { const keep = (state.queue[key] ?? []).filter((item) => Date.parse(item.deadlineAt) > nowMs); if (keep.length !== (state.queue[key] ?? []).length) { state.queue[key] = keep; changed = true; } } if (changed) persist(); }
  const reaper = setInterval(() => { void sweep(); }, timers.reapIntervalMs); reaper.unref?.();
  return {
    handleTaskCommand, reapOnce: sweep,
    status: () => ({ leases: Object.entries(state.leases).map(([key, row]) => ({ ...splitKey(key), assignmentId: row.assignment.assignmentId, nodeId: row.assignment.nodeId, executionId: row.executionId, acquiredAt: row.acquiredAt, expiresAt: row.expiresAt })), queue: Object.entries(state.queue).flatMap(([key, items]) => items.map((item) => ({ ...splitKey(key), assignmentId: item.assignment.assignmentId, opId: item.opId, seq: item.seq, enqueuedAt: item.enqueuedAt, deadlineAt: item.deadlineAt }))) }),
    close: () => { clearInterval(reaper); for (const [opId, park] of [...parks.entries()]) park({ ...failure("op_rejected", "center_closing", "The fleet center is shutting down; resubmit to re-attach to the persisted queue."), opId }); parks.clear(); }
  };
}
function loadState(file: string): BrokerState { if (!existsSync(file)) return { seq: 0, leases: {}, queue: {}, receipts: {} }; const value = JSON.parse(readFileSync(file, "utf8")) as BrokerState & Record<string, unknown>; if (value.schema !== "fleet-lease-state/v1" || typeof value.seq !== "number" || value.leases === null || typeof value.leases !== "object" || value.queue === null || typeof value.queue !== "object" || value.receipts === null || typeof value.receipts !== "object") throw new Error("Fleet lease broker state contains an unrecognized shape"); return { seq: value.seq, leases: value.leases, queue: value.queue, receipts: value.receipts }; }
function writeDurableJson(file: string, value: unknown): void { mkdirSync(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`, fd = openSync(temp, "w"); try { writeFileSync(fd, `${JSON.stringify({ schema: "fleet-lease-state/v1", ...(value as object) })}\n`); fsyncSync(fd); } finally { closeSync(fd); } renameSync(temp, file); const dir = openSync(path.dirname(file), "r"); try { fsyncSync(dir); } finally { closeSync(dir); } }
