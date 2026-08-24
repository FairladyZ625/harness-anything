import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import {
  freezeDeclaredWritePlan,
  hasOnlyFields,
  hasRequiredFields,
  isFrozenWritePlan,
  isNonEmptyString,
  isRecord,
  validateEventEnvelopeIdentity,
  type ActorIdentity,
  type EventEnvelope,
  type FrozenWritePlan,
  type WriteSource,
  type WriteTarget,
} from "./write-chain.contract.ts";
import type { LeaseV1 } from "./execution.ts";
import { isSameExecution } from "./actor-domain-services.ts";
import { isTaskBoundRuntimeWriter, type LiveTaskBoundRuntimeBinding } from "./task-bound-runtime-authority.ts";
import { isValidDocEventChange, type DocEventChange } from "./doc-sync.contract.ts";

export const TASK_PROGRESS_POLICY_ID = "typed-machine-writer/v1" as const;
export interface TaskProgressEvidence {
  readonly type: string;
  readonly path: string;
  readonly summary: string;
}
export interface ProgressDocumentClaim {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: "text/markdown";
  readonly policyId: typeof TASK_PROGRESS_POLICY_ID;
}
export interface TaskProgressBlob {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: "text/markdown";
  readonly body: string;
}
export type TaskProgressEventV1 = EventEnvelope<
  "task-progress-event/v1",
  "task_progress_appended",
  ActorIdentity,
  {
    readonly taskId: string;
    readonly executionId: string;
    readonly text: string;
    readonly evidence: readonly TaskProgressEvidence[];
    readonly baseDocumentSha256: string | null;
    readonly resultDocumentClaim: ProgressDocumentClaim;
    readonly runtimeSessionId?: string;
    readonly carriedDocumentClaims?: readonly DocEventChange[];
  }
>;
export interface ProgressDocumentState {
  readonly path: string;
  readonly blobSha256: string;
  readonly body: string;
}
export class TaskProgressError extends Error {
  readonly code: "invalid_progress" | "progress_lease_required" | "progress_lease_mismatch" | "stale_progress_base";
  constructor(code: TaskProgressError["code"], message: string) {
    super(message);
    this.name = "TaskProgressError";
    this.code = code;
  }
}

/** Reads the lease record the caller already holds; lapsed-ness stays the projection's single derivation (phase=orphaned). */
function progressLeaseRequiredMessage(taskId: string, lease: LeaseV1 | null, startRecoveryAvailable: boolean): string {
  const unavailable =
    "task start cannot re-enter the current lifecycle state, so progress append has no recovery in this state";
  if (lease === null)
    return startRecoveryAvailable
      ? `progress append requires an active lease; run ha task start ${taskId} --execution-id <id>`
      : `progress append requires an active lease; ${unavailable}`;
  if (lease.phase === "orphaned")
    return startRecoveryAvailable
      ? `the lease for execution ${lease.executionId} lapsed at ${lease.expiresAt}; run ha task release ${taskId}, then re-enter the round with ha task start ${taskId} --execution-id ${lease.executionId}`
      : `the lease for execution ${lease.executionId} lapsed at ${lease.expiresAt}; ${unavailable}`;
  if (lease.phase === "reserving")
    return `a lease reservation for execution ${lease.executionId} is in flight until ${lease.expiresAt}; wait for the holder to publish it or for the reservation to lapse, then retry progress append`;
  return startRecoveryAvailable
    ? `the lease for execution ${lease.executionId} was released; re-enter the round with ha task start ${taskId} --execution-id ${lease.executionId}`
    : `the lease for execution ${lease.executionId} was released; ${unavailable}`;
}
function progressLeaseMismatchMessage(taskId: string, lease: LeaseV1): string {
  const executor = lease.actor.executor === null ? "none" : `${lease.actor.executor.kind}:${lease.actor.executor.id}`;
  return `Progress append requires the active lease holder (personId=${lease.actor.principal.personId}, executor=${executor}) for execution ${lease.executionId}; that holder must run ha task progress append ${taskId} --text <text>, or run ha task release ${taskId}, then this caller can run ha task start ${taskId} --execution-id ${lease.executionId} before retrying progress append.`;
}
export function compileTaskProgress(input: {
  readonly taskId: string;
  readonly executionId: string;
  readonly packagePath: string;
  readonly text: string;
  readonly evidence: readonly TaskProgressEvidence[];
  readonly expectedBaseSha256?: string | null;
  readonly currentDocument: ProgressDocumentState | null;
  readonly activeLease: LeaseV1 | null;
  readonly startRecoveryAvailable: boolean;
  readonly runtimeBinding?: LiveTaskBoundRuntimeBinding;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly eventId: string;
  readonly opId: string;
  readonly workspaceRevision: number;
  readonly occurredAt: string;
}): {
  readonly event: TaskProgressEventV1;
  readonly plan: FrozenWritePlan<"TaskProgressAppend">;
  readonly blobs: readonly [TaskProgressBlob];
  readonly body: string;
  readonly path: string;
} {
  if (
    !validText(input.text) ||
    !Array.isArray(input.evidence) ||
    !input.evidence.every((entry) => validEvidence(entry)) ||
    !validTimestamp(input.occurredAt)
  )
    throw new TaskProgressError("invalid_progress", "progress text, timestamp, or evidence is invalid");
  const progressPath = `${input.packagePath}/progress.md`;
  try {
    if (
      normalizeRelativeDocumentPath(progressPath) !== progressPath ||
      !input.packagePath.startsWith(`tasks/${input.taskId}-`)
    )
      throw new Error();
  } catch {
    throw new TaskProgressError("invalid_progress", "progress package path is invalid");
  }
  const lease = input.activeLease;
  if (lease === null || lease.phase !== "held")
    throw new TaskProgressError(
      "progress_lease_required",
      progressLeaseRequiredMessage(input.taskId, lease, input.startRecoveryAvailable),
    );
  const directHolder = isSameExecution(lease.actor, input.actor) && input.runtimeBinding === undefined,
    runtimeWorker =
      input.runtimeBinding !== undefined &&
      isTaskBoundRuntimeWriter(lease, input.actor, input.source, input.runtimeBinding);
  if (
    lease.taskId !== input.taskId ||
    lease.executionId !== input.executionId ||
    stableStringify(lease.source) !== stableStringify(input.source) ||
    (!directHolder && !runtimeWorker)
  )
    throw new TaskProgressError("progress_lease_mismatch", progressLeaseMismatchMessage(input.taskId, lease));
  if (
    (input.currentDocument !== null && input.currentDocument.path !== progressPath) ||
    (input.expectedBaseSha256 !== undefined && input.expectedBaseSha256 !== (input.currentDocument?.blobSha256 ?? null))
  )
    throw new TaskProgressError("stale_progress_base", "progress base changed; refresh task progress before appending");
  const body = renderTaskProgressDocument(
      input.currentDocument?.body ?? null,
      input.occurredAt,
      input.text,
      input.evidence,
    ),
    claim: ProgressDocumentClaim = {
      path: progressPath,
      sha256: sha256Text(body),
      size: Buffer.byteLength(body),
      mediaType: "text/markdown",
      policyId: TASK_PROGRESS_POLICY_ID,
    };
  const event: TaskProgressEventV1 = {
    schema: "task-progress-event/v1",
    eventId: input.eventId,
    workspaceRevision: input.workspaceRevision,
    opId: input.opId,
    type: "task_progress_appended",
    actor: input.actor,
    source: input.source,
    occurredAt: input.occurredAt,
    payload: {
      taskId: input.taskId,
      executionId: input.executionId,
      text: input.text,
      evidence: input.evidence,
      baseDocumentSha256: input.currentDocument?.blobSha256 ?? null,
      resultDocumentClaim: claim,
      ...(input.runtimeBinding ? { runtimeSessionId: input.runtimeBinding.runtimeSessionId } : {}),
    },
  };
  return {
    event,
    plan: taskProgressWritePlan(event),
    blobs: [{ sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType, body }],
    body,
    path: progressPath,
  };
}
export function renderTaskProgressDocument(
  current: string | null,
  occurredAt: string,
  text: string,
  evidence: readonly TaskProgressEvidence[],
): string {
  const base = current ?? "# Progress\n\n## Entries\n\n",
    suffix = `### ${occurredAt}\n\n${text}${text.endsWith("\n") ? "" : "\n"}${evidence.map((item) => `Evidence: ${item.type}:${item.path}:${item.summary}\n`).join("")}\n`,
    next = `${base}${suffix}`;
  if (!next.startsWith(base))
    throw new TaskProgressError("stale_progress_base", "progress append must preserve every existing byte");
  return next;
}
export function taskProgressWritePlan(event: TaskProgressEventV1): FrozenWritePlan<"TaskProgressAppend"> {
  const claim = event.payload.resultDocumentClaim,
    targets: WriteTarget[] = [
      { kind: "event_file", path: eventObjectTarget(event.opId), operation: "create" },
      { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
      {
        kind: "authored_file",
        path: claim.path,
        operation: "replace",
        sha256: claim.sha256,
        size: claim.size,
        mediaType: claim.mediaType,
      },
      { kind: "content_blob", sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType },
      { kind: "projection_invalidation", projection: "task-progress/v1", key: event.payload.taskId },
      { kind: "projection_invalidation", projection: "document/v1", key: claim.path },
    ];
  for (const carried of event.payload.carriedDocumentClaims ?? [])
    targets.push(
      {
        kind: "authored_file",
        path: carried.path,
        operation: "replace",
        sha256: carried.candidate.sha256,
        size: carried.candidate.size,
        mediaType: carried.candidate.mediaType,
      },
      {
        kind: "content_blob",
        sha256: carried.candidate.sha256,
        size: carried.candidate.size,
        mediaType: carried.candidate.mediaType,
      },
      { kind: "projection_invalidation", projection: "document/v1", key: carried.path },
    );
  return freezeDeclaredWritePlan({ commandType: "TaskProgressAppend", targets }, ["TaskProgressAppend"]);
}
export function assertTaskProgressWritePlan(event: TaskProgressEventV1, plan: FrozenWritePlan | undefined): void {
  const shape = (value: FrozenWritePlan) =>
    stableStringify({ commandType: value.commandType, targets: value.targets.map(stableStringify).sort() });
  if (!plan || !isFrozenWritePlan(plan) || shape(plan) !== shape(taskProgressWritePlan(event)))
    throw new TaskProgressError(
      "invalid_progress",
      "progress write plan must exactly declare event, document, blob, and projection targets",
    );
}
export function validateTaskProgressEvent(value: unknown): readonly string[] {
  return validateTaskProgressEventFields(value, true);
}
export function validateCurrentTaskProgressEvent(value: unknown): readonly string[] {
  return validateTaskProgressEventFields(value, false);
}
function validateTaskProgressEventFields(value: unknown, allowUnknownFields: boolean): readonly string[] {
  const hasFields = allowUnknownFields ? hasRequiredFields : hasOnlyFields;
  if (
    !isRecord(value) ||
    !hasFields(value, [
      "schema",
      "eventId",
      "workspaceRevision",
      "opId",
      "type",
      "actor",
      "source",
      "occurredAt",
      "payload",
    ]) ||
    value.schema !== "task-progress-event/v1" ||
    value.type !== "task_progress_appended" ||
    !validTimestamp(value.occurredAt) ||
    !isRecord(value.payload)
  )
    return ["task progress event envelope or payload is invalid"];
  const payload = value.payload,
    carried = payload.carriedDocumentClaims,
    runtimeSessionId = payload.runtimeSessionId,
    payloadWithoutOptional = Object.fromEntries(
      Object.entries(payload).filter(([key]) => key !== "carriedDocumentClaims" && key !== "runtimeSessionId"),
    ),
    claim = payload.resultDocumentClaim;
  if (
    !hasFields(payloadWithoutOptional, [
      "taskId",
      "executionId",
      "text",
      "evidence",
      "baseDocumentSha256",
      "resultDocumentClaim",
    ]) ||
    (carried !== undefined &&
      (!Array.isArray(carried) ||
        carried.length === 0 ||
        carried.some((change) => !isValidDocEventChange(change, allowUnknownFields)))) ||
    (runtimeSessionId !== undefined &&
      (!isNonEmptyString(runtimeSessionId) || !isRuntimeSessionActor(value.actor, runtimeSessionId))) ||
    !isNonEmptyString(payload.taskId) ||
    !isNonEmptyString(payload.executionId) ||
    !validText(payload.text) ||
    !Array.isArray(payload.evidence) ||
    !payload.evidence.every((entry) => validEvidence(entry, allowUnknownFields)) ||
    (payload.baseDocumentSha256 !== null && !isProgressClaimHash(payload.baseDocumentSha256)) ||
    !validProgressClaim(claim, allowUnknownFields) ||
    !(claim as ProgressDocumentClaim).path.startsWith(`tasks/${payload.taskId}-`) ||
    !(claim as ProgressDocumentClaim).path.endsWith("/progress.md")
  )
    return ["task progress event payload is invalid"];
  return validateEventEnvelopeIdentity(value, allowUnknownFields).length
    ? ["task progress event identity is invalid"]
    : [];
}
export function isTaskProgressEvent(event: { readonly schema: string }): event is TaskProgressEventV1 {
  return event.schema === "task-progress-event/v1";
}
function isRuntimeSessionActor(actor: unknown, runtimeSessionId: string): boolean {
  return (
    isRecord(actor) &&
    isRecord(actor.executor) &&
    actor.executor.kind === "agent" &&
    actor.executor.id === `runtime-session:${runtimeSessionId}`
  );
}
function validProgressClaim(value: unknown, allowUnknownFields = false): value is ProgressDocumentClaim {
  if (
    !isRecord(value) ||
    !(allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, [
      "path",
      "sha256",
      "size",
      "mediaType",
      "policyId",
    ]) ||
    !isProgressClaimHash(value.sha256) ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0 ||
    value.mediaType !== "text/markdown" ||
    value.policyId !== TASK_PROGRESS_POLICY_ID
  )
    return false;
  try {
    return normalizeRelativeDocumentPath(String(value.path)) === value.path;
  } catch {
    return false;
  }
}
function validEvidence(value: unknown, allowUnknownFields = false): value is TaskProgressEvidence {
  if (
    !isRecord(value) ||
    !(allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, ["type", "path", "summary"]) ||
    !/^[a-z][a-z0-9_-]{0,31}$/u.test(String(value.type)) ||
    String(value.path).includes(":") ||
    !validText(value.summary)
  )
    return false;
  try {
    return normalizeRelativeDocumentPath(String(value.path)) === value.path;
  } catch {
    return false;
  }
}
function validText(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(value)) === value;
  } catch {
    return false;
  }
}
function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function isProgressClaimHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
