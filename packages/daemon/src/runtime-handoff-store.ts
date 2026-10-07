import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  resolveHarnessLayout,
  runtimeSessionMissingOutcomeEvidence,
  sha256Bytes,
  stableStringify,
  type WriteReceiptDraft,
  type WriteSource,
} from "@harness-anything/kernel";
import { writeFileDurably, readFileWindow, removeFileDurably } from "./durable-file.ts";
import { runtimeSpawnError } from "./runtime-spawn-errors.ts";
import { validateHandoffRollout } from "./runtime-handoff-native.ts";
import type { RepoCellActionContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { FLEET_CHUNK_BYTES, type FleetDescriptor } from "./fleet/contract.ts";

export interface RuntimeHandoffCheckpoint {
  readonly dispatchId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly runtimeSessionId: string;
  readonly ownerPersonId: string;
  readonly source: WriteSource;
  readonly providerSessionId: string;
  readonly commit: string;
  readonly version: string;
  readonly agentId: string;
  readonly model: string;
  readonly blob: Pick<FleetDescriptor, "sha256" | "size" | "mediaType">;
  readonly exportedAt: string;
  readonly revokedAt: string | null;
}

function directory(rootDir: string, dispatchId: string): string {
  if (!/^dispatch_[a-f0-9]{24}$/u.test(dispatchId))
    throw runtimeSpawnError("invalid_field", "A canonical dispatch ID is required.");
  return path.join(resolveHarnessLayout(rootDir).localRoot, "runtime-handoffs", dispatchId);
}
export function readHandoffCheckpoint(rootDir: string, dispatchId: string): RuntimeHandoffCheckpoint | null {
  if (!/^dispatch_[a-f0-9]{24}$/u.test(dispatchId)) return null;
  const file = path.join(directory(rootDir, dispatchId), "checkpoint.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as RuntimeHandoffCheckpoint) : null;
}

/** Runs only under the center RepoCell write queue. Payloads are never canonical document claims. */
export function runRuntimeHandoffAction(
  cell: RepoCellActionContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceiptDraft {
  const dispatchId = cell.requiredCellText(action.dispatchId, "dispatchId"),
    location = directory(cell.rootDir, dispatchId),
    previous = readHandoffCheckpoint(cell.rootDir, dispatchId),
    source = cell.projection.readRuntimeDispatchById(dispatchId)?.event;
  if (!source || source.actor.principal.personId !== binding.actor.principal.personId)
    throw runtimeSpawnError("runtime_handoff_owner_mismatch", "The authenticated person must own the source dispatch.");
  const payload = source.payload;
  const result = (value: object) => ({
    outcome: "no_changes" as const,
    opId: `${action.kind}-${dispatchId}`,
    evidence: `Private handoff read for ${dispatchId}`,
    ...value,
  });
  if (action.kind === "runtime-handoff-export") {
    if (stableStringify(source.source) !== stableStringify(binding.source))
      throw runtimeSpawnError("runtime_handoff_source_mismatch", "Export must originate on the source node.");
    if (previous) {
      if (previous.revokedAt) throw runtimeSpawnError("runtime_handoff_revoked", "This export was revoked.");
      return auditCheckpoint(cell, previous, binding, "export");
    }
    const session = cell.projection.readRuntimeSession(payload.runtimeSessionId);
    if (
      !payload.handoffEnabled ||
      payload.kindId !== "codex" ||
      !payload.taskId ||
      !payload.executionId ||
      !payload.agentId ||
      !session?.providerSessionId ||
      session.liveness !== "exited" ||
      !session.outcome ||
      // Handoff continues work whose delivery was never witnessed, so eligibility is settledness
      // (complete exit/result evidence), not a success verdict the session never declared.
      runtimeSessionMissingOutcomeEvidence(session) !== null
    )
      throw runtimeSpawnError("runtime_handoff_ineligible", "The opted-in task-bound Codex source must be settled.");
    if (cell.projection.readRuntimeDispatchByResumeSource(dispatchId))
      throw runtimeSpawnError("runtime_dispatch_already_resumed", "The source has already been resumed.");
    const snapshot = cell.projection.read(payload.taskId).snapshot;
    if (["submitted", "in_review", "done", "cancelled"].includes(String(snapshot.task?.status)))
      throw runtimeSpawnError(
        "runtime_task_execution_frozen",
        "Return or reopen the task through its existing lifecycle first.",
      );
    if (cell.projection.currentLease(payload.taskId, cell.now())?.phase === "held")
      throw runtimeSpawnError(
        "runtime_handoff_source_active",
        "The source execution lease must be released after settlement.",
      );
    const commit = cell.requiredCellText(action.commit, "commit"),
      descriptor = action.candidate as FleetDescriptor | undefined;
    if (!/^[a-f0-9]{40}$/u.test(commit) || !descriptor || !/^doc-sync-claims\/[a-zA-Z0-9_-]+$/u.test(descriptor.ref))
      throw runtimeSpawnError(
        "runtime_handoff_payload_invalid",
        "An exact commit and owned private upload are required.",
      );
    const body = readFileSync(path.join(resolveHarnessLayout(cell.rootDir).localRoot, descriptor.ref));
    if (body.byteLength !== descriptor.size || sha256Bytes(body) !== descriptor.sha256)
      throw runtimeSpawnError("content_claim_mismatch", "The private rollout differs from its upload descriptor.");
    const version = validateHandoffRollout(body, session.providerSessionId);
    const checkpoint: RuntimeHandoffCheckpoint = {
      dispatchId,
      taskId: payload.taskId,
      executionId: payload.executionId,
      runtimeSessionId: payload.runtimeSessionId,
      ownerPersonId: binding.actor.principal.personId,
      source: source.source,
      providerSessionId: session.providerSessionId,
      commit,
      version,
      agentId: payload.agentId,
      model: payload.definitionSnapshot.model,
      blob: { sha256: descriptor.sha256, size: descriptor.size, mediaType: descriptor.mediaType },
      exportedAt: cell.now(),
      revokedAt: null,
    };
    writeFileDurably(path.join(location, "rollout.jsonl"), body, 0o600);
    writeFileDurably(path.join(location, "checkpoint.json"), JSON.stringify(checkpoint), 0o600);
    return auditCheckpoint(cell, checkpoint, binding, "export");
  }
  if (!previous) throw runtimeSpawnError("runtime_handoff_missing", "The source has no accepted checkpoint.");
  if (action.kind === "runtime-handoff-revoke") {
    const checkpoint = { ...previous, revokedAt: previous.revokedAt ?? cell.now() };
    writeFileDurably(path.join(location, "checkpoint.json"), JSON.stringify(checkpoint), 0o600);
    removeFileDurably(path.join(location, "rollout.jsonl"));
    return auditCheckpoint(cell, checkpoint, binding, "revoke");
  }
  const successor = cell.projection.readRuntimeDispatchByResumeSource(dispatchId)?.event;
  if (
    successor &&
    action.idempotencyKey === successor.payload.idempotencyKey &&
    stableStringify(successor.source) === stableStringify(binding.source)
  ) {
    const receipt: WriteReceiptDraft = cell.receiptForOperation(successor.opId, binding);
    const replay = {
      ...receipt,
      outcome: "applied" as const,
      opId: successor.opId,
      replayed: true,
      handoffResumed:
        cell.projection.readRuntimeSession(successor.payload.runtimeSessionId)?.providerSessionId ===
        previous.providerSessionId,
      dispatchId: successor.payload.dispatchId,
      runtimeSessionId: successor.payload.runtimeSessionId,
    };
    return replay;
  }
  assertHandoffClaim(cell, previous, binding);
  if (action.offset === undefined) return result({ checkpoint: previous });
  const offset = action.offset;
  if (!Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > previous.blob.size)
    throw runtimeSpawnError("invalid_field", "The private payload offset is invalid.");
  const bytes = readFileWindow(path.join(location, "rollout.jsonl"), Number(offset), FLEET_CHUNK_BYTES);
  return result({
    dataBase64: bytes.toString("base64"),
    nextOffset: Number(offset) + bytes.length,
    done: Number(offset) + bytes.length === previous.blob.size,
  });
}

export function assertHandoffClaim(
  cell: RepoCellActionContext,
  checkpoint: RuntimeHandoffCheckpoint,
  binding: RepoCellBinding,
): void {
  if (!cell.store.readEvent(`runtime-handoff-export-${checkpoint.dispatchId}`))
    throw runtimeSpawnError(
      "runtime_handoff_pending",
      "The export audit has not been accepted; retry export on the source.",
    );
  if (checkpoint.ownerPersonId !== binding.actor.principal.personId)
    throw runtimeSpawnError("runtime_handoff_owner_mismatch", "The checkpoint belongs to another person.");
  if (checkpoint.revokedAt) throw runtimeSpawnError("runtime_handoff_revoked", "The checkpoint has been revoked.");
  if (stableStringify(checkpoint.source) === stableStringify(binding.source))
    throw runtimeSpawnError("runtime_handoff_target_same", "Claim on a different authenticated node.");
  if (cell.projection.readRuntimeDispatchByResumeSource(checkpoint.dispatchId))
    throw runtimeSpawnError("runtime_dispatch_already_resumed", "The checkpoint has already been consumed.");
  const held = cell.projection.currentLease(checkpoint.taskId, cell.now());
  if (
    !held ||
    held.phase !== "held" ||
    held.actor.principal.personId !== binding.actor.principal.personId ||
    stableStringify(held.source) !== stableStringify(binding.source)
  )
    throw runtimeSpawnError(
      "runtime_task_lease_required",
      `Start task ${checkpoint.taskId} on this node through its existing lifecycle before claiming.`,
    );
  const status = cell.projection.read(checkpoint.taskId).snapshot.task?.status;
  if (status !== "active")
    throw runtimeSpawnError("runtime_task_execution_frozen", "Handoff requires an active execution.");
}

export function admitHandoffDispatch(
  cell: RepoCellActionContext,
  payload: Readonly<Record<string, unknown>>,
  binding: RepoCellBinding,
): void {
  const sourceId = typeof payload.resumedFromDispatchId === "string" ? payload.resumedFromDispatchId : null;
  const checkpoint = sourceId ? readHandoffCheckpoint(cell.rootDir, sourceId) : null;
  if (payload.handoffCheckpointId !== undefined && (!checkpoint || payload.handoffCheckpointId !== sourceId))
    throw runtimeSpawnError("runtime_handoff_missing", "The handoff checkpoint does not match its source dispatch.");
  if (!checkpoint) {
    if (!sourceId && typeof payload.resumeProviderSessionId === "string") {
      for (const session of cell.projection.readRuntimeSessions()) {
        if (session.providerSessionId !== payload.resumeProviderSessionId) continue;
        const dispatch = cell.projection.readRuntimeDispatch(session.runtimeSessionId);
        if (dispatch && readHandoffCheckpoint(cell.rootDir, dispatch.payload.dispatchId))
          throw runtimeSpawnError(
            "runtime_handoff_source_exported",
            "Use the explicit handoff claim to resume an exported native session.",
          );
      }
    }
    return;
  }
  if (payload.handoffCheckpointId !== sourceId)
    throw runtimeSpawnError(
      "runtime_handoff_source_exported",
      "This source was exported; use the target handoff claim action.",
    );
  assertHandoffClaim(cell, checkpoint, binding);
  const lease = cell.projection.currentLease(checkpoint.taskId, cell.now());
  if (
    payload.acceptedCommit !== checkpoint.commit ||
    payload.resumeProviderSessionId !== checkpoint.providerSessionId ||
    payload.taskId !== checkpoint.taskId ||
    payload.executionId !== lease?.executionId ||
    payload.kindId !== "codex"
  )
    throw runtimeSpawnError(
      "runtime_handoff_binding_mismatch",
      "Resume must retain the checkpoint commit, native session, task and execution.",
    );
}

function auditCheckpoint(
  cell: RepoCellActionContext,
  checkpoint: RuntimeHandoffCheckpoint,
  binding: RepoCellBinding,
  operation: "export" | "revoke",
) {
  const receipt = cell.appendAuxiliaryRuntimeIngress(
    {
      kind: "event",
      type: operation === "export" ? "runtime_handoff_exported" : "runtime_handoff_revoked",
      opId: `runtime-handoff-${operation}-${checkpoint.dispatchId}`,
      payload: {
        dispatchId: checkpoint.dispatchId,
        runtimeSessionId: checkpoint.runtimeSessionId,
        ...(operation === "export"
          ? {
              taskId: checkpoint.taskId,
              executionId: checkpoint.executionId,
              commit: checkpoint.commit,
              sha256: checkpoint.blob.sha256,
            }
          : {}),
      },
    },
    binding,
    true,
  );
  return { ...receipt, checkpoint } as unknown as WriteReceiptDraft;
}
