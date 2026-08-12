import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import { stableStringify } from "../integrity/stable-hash.ts";
import { validateTaskV1, type TaskV1 } from "./task.ts";
import { freezeDeclaredWritePlan, hasOnlyFields, isFrozenWritePlan, isNonEmptyString, isRecord, serializeEventEnvelope, validateActorIdentity, validateWriteSource,
  type ActorIdentity, type EventEnvelope, type FrozenWritePlan, type WriteTarget } from "./write-chain.contract.ts";

export interface PresetSnapshotClaim { readonly digest: `sha256:${string}`; readonly sha256: string; readonly size: number; readonly mediaType: "application/json" }
export interface InitialDocumentClaim { readonly path: string; readonly sha256: string; readonly size: number; readonly mediaType: "text/markdown" | "text/plain"; readonly policyId: "markdown-additive/v1" }
export interface TaskBootstrapBlob { readonly sha256: string; readonly size: number; readonly mediaType: string; readonly body: string }
export type TaskBootstrapEventV1 = EventEnvelope<"task-bootstrap-event/v1", "task_bootstrapped", ActorIdentity, {
  readonly task: TaskV1; readonly presetSnapshotClaim: PresetSnapshotClaim; readonly initialDocumentClaims: readonly InitialDocumentClaim[]
}> & { readonly taskId: string };
export const TASK_BOOTSTRAP_EVENT_SCHEMA = Object.freeze({ id: "task-bootstrap-event/v1", required: Object.freeze(["schema", "eventId", "workspaceRevision", "opId", "taskId", "type", "actor", "source", "occurredAt", "payload"]) });

export function validateTaskBootstrapEvent(value: unknown): readonly string[] {
  if (!isRecord(value) || !hasOnlyFields(value, TASK_BOOTSTRAP_EVENT_SCHEMA.required) || value.schema !== "task-bootstrap-event/v1" || value.type !== "task_bootstrapped" || !isNonEmptyString(value.taskId) || !isNonEmptyString(value.eventId) || !isNonEmptyString(value.opId) || !isNonEmptyString(value.occurredAt) || !Number.isInteger(value.workspaceRevision) || (value.workspaceRevision as number) < 1 || validateActorIdentity(value.actor).length || validateWriteSource(value.source).length || !isRecord(value.payload) || !hasOnlyFields(value.payload, ["task", "presetSnapshotClaim", "initialDocumentClaims"])) return ["task bootstrap event envelope or payload is invalid"];
  const taskIssues = validateTaskV1(value.payload.task), snapshot = value.payload.presetSnapshotClaim, documents = value.payload.initialDocumentClaims;
  if (taskIssues.length) return taskIssues.map((issue) => issue.message);
  if ((value.payload.task as TaskV1).taskId !== value.taskId || !validSnapshotClaim(snapshot) || (value.payload.task as TaskV1).presetSnapshotDigest !== (snapshot as PresetSnapshotClaim).digest || !Array.isArray(documents) || documents.length === 0 || !documents.every(validDocumentClaim) || new Set(documents.map((claim) => isRecord(claim) ? claim.path : null)).size !== documents.length) return ["task bootstrap claims are invalid"];
  try { serializeEventEnvelope(value as unknown as TaskBootstrapEventV1); } catch { return ["task bootstrap event identity is invalid"]; }
  return [];
}
export function isTaskBootstrapEvent(event: { readonly schema: string }): event is TaskBootstrapEventV1 { return event.schema === "task-bootstrap-event/v1"; }
export function taskBootstrapWritePlan(event: TaskBootstrapEventV1): FrozenWritePlan<"TaskBootstrap"> {
  const targets: WriteTarget[] = [{ kind: "event_file", path: `harness/events/${event.opId}.json`, operation: "create" }, { kind: "event_head", path: "harness/events/head.json", operation: "replace" }, { kind: "projection_invalidation", projection: "task-lifecycle/v1", key: event.taskId }, { kind: "projection_invalidation", projection: "preset-snapshot/v1", key: event.payload.presetSnapshotClaim.digest }];
  for (const claim of event.payload.initialDocumentClaims) targets.push({ kind: "projection_invalidation", projection: "document/v1", key: claim.path });
  for (const claim of uniqueClaims(event)) targets.push({ kind: "content_blob", sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType });
  return freezeDeclaredWritePlan({ commandType: "TaskBootstrap", targets }, ["TaskBootstrap"]);
}
export function assertTaskBootstrapWritePlan(event: TaskBootstrapEventV1, plan: FrozenWritePlan<"TaskBootstrap"> | undefined): asserts plan is FrozenWritePlan<"TaskBootstrap"> {
  const shape = (candidate: FrozenWritePlan<"TaskBootstrap">) => stableStringify({ commandType: candidate.commandType, targets: candidate.targets.map(stableStringify).sort() });
  if (plan === undefined || !isFrozenWritePlan(plan) || shape(plan) !== shape(taskBootstrapWritePlan(event))) throw new Error("task bootstrap write plan must exactly declare event, task, snapshot, documents, and blobs");
}
export function taskBootstrapClaims(event: TaskBootstrapEventV1): readonly (PresetSnapshotClaim | InitialDocumentClaim)[] { return uniqueClaims(event); }
function uniqueClaims(event: TaskBootstrapEventV1): readonly (PresetSnapshotClaim | InitialDocumentClaim)[] { return [...new Map([event.payload.presetSnapshotClaim, ...event.payload.initialDocumentClaims].map((claim) => [claim.sha256, claim])).values()]; }
function validSnapshotClaim(value: unknown): value is PresetSnapshotClaim { return isRecord(value) && hasOnlyFields(value, ["digest", "sha256", "size", "mediaType"]) && /^sha256:[0-9a-f]{64}$/u.test(String(value.digest)) && validStoredClaim(value) && value.mediaType === "application/json"; }
function validDocumentClaim(value: unknown): value is InitialDocumentClaim { if (!isRecord(value) || !hasOnlyFields(value, ["path", "sha256", "size", "mediaType", "policyId"]) || !validStoredClaim(value) || value.policyId !== "markdown-additive/v1" || value.mediaType !== "text/markdown" && value.mediaType !== "text/plain") return false; try { return normalizeRelativeDocumentPath(String(value.path)) === value.path; } catch { return false; } }
function validStoredClaim(value: Readonly<Record<string, unknown>>): boolean { return /^[0-9a-f]{64}$/u.test(String(value.sha256)) && Number.isSafeInteger(value.size) && (value.size as number) >= 0 && isNonEmptyString(value.mediaType); }
