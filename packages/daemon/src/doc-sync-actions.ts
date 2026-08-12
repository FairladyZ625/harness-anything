import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DOC_POLICY_ID, decideDocWrite, docSyncWritePlan, documentPath, isDocEvent, normalizeCommandEnvelope, parseDocWriteIntent, resolveDocRoute, resolveHarnessLayout, sha256Bytes, stableStringify,
  type ActorIdentity, type DocClaimRef, type DocEventV1, type DocSyncReceiptDetail, type DocWriteIntent, type EventPublicationKillpoint, type LedgerCommitSha, type WriteReceipt, type WriteSource } from "../../kernel/src/index.ts";
import type { CanonicalEventStore, TaskProjection } from "../../kernel/src/index.ts";

export const DOC_COMMAND_FRAME_MAX_BYTES = 256 * 1024;
type Action = Readonly<Record<string, unknown>> & { readonly kind: string };
interface Binding { readonly actor: ActorIdentity; readonly source: WriteSource; readonly docWriteAllowed?: boolean; readonly assignmentScope?: AssignmentScope }
interface AssignmentScope { readonly repoId: string; readonly taskId: string; readonly executionId: string; readonly paths: readonly string[] }
type Input = { readonly action: Action; readonly binding: Binding; readonly workspaceId: string; readonly rootDir: string; readonly store: CanonicalEventStore; readonly projection: TaskProjection; readonly now: () => string; readonly killpoint?: (point: EventPublicationKillpoint) => void };

export function isDocAction(kind: string): boolean { return kind === "doc-status" || kind === "doc-submit" || kind === "doc-show"; }
export async function runDocAction(input: Input): Promise<WriteReceipt> {
  if (Buffer.byteLength(JSON.stringify(input.action)) > DOC_COMMAND_FRAME_MAX_BYTES) throw coded("invalid_command", "doc command frame exceeds the descriptor-only limit");
  if (input.action.kind !== "doc-submit") return readAction(input);
  const intent = intentFrom(input), baseRevision = input.store.revisionAt(intent.baseLedgerSha), envelope = normalizeCommandEnvelope({ workspaceId: input.workspaceId,
    actor: input.binding.actor, source: input.binding.source, expectedRevision: baseRevision ?? 0, command: intent as unknown as Readonly<Record<string, unknown>> }), existing = input.store.readEvent(envelope.opId);
  if (existing !== null) { if (!isDocEvent(existing) || !matches(existing, intent, input.binding.actor, input.binding.source)) { recycleClaims(input.rootDir, intent); return reject(envelope.opId, "op_conflict", detail(intent, input.store.currentCommit(), "op_conflict", null), "query the existing operation before resubmitting"); }
    if (input.projection.readOperation(existing.opId) === null) input.projection.apply(existing, docSyncWritePlan(existing)); const receipt = readDocReceipt(input, existing); recycleClaims(input.rootDir, intent); return receipt; }
  const documents = intent.changes.map((change) => input.projection.readDocument(change.path));
  if (documents.some((read) => read.status !== "ready")) return { outcome: "indeterminate", opId: envelope.opId, code: "projection_pending", origin: "N/A", nextAction: "retry after the canonical projection catches up" };
  const lease = input.projection.currentLeaseForExecution(intent.executionId, input.now()), admission = admissionRejection(input, intent, lease);
  if (admission) { recycleClaims(input.rootDir, intent); return reject(envelope.opId, admission.code, admission.detail, admission.detail.nextAction); }
  const claims = intent.changes.map((change) => change.candidate === null ? null : claimBytes(input.rootDir, change.candidate.ref));
  const decision = decideDocWrite({ intent, opId: envelope.opId, eventId: `event-${sha256Bytes(Buffer.from(envelope.opId))}`, workspaceRevision: (input.store.readHead()?.revision ?? 0) + 1,
    actor: input.binding.actor, source: input.binding.source, occurredAt: input.now(), currentLedgerSha: input.store.currentCommit(), lease, documents: documents.map((read) => read.document), claims });
  if (!decision.accepted) { recycleClaims(input.rootDir, intent); return reject(envelope.opId, decision.code, decision.detail, decision.detail.nextAction); }
  input.store.append(decision.event, decision.plan, decision.blobs); input.projection.apply(decision.event, decision.plan); input.killpoint?.("after_sqlite_commit"); input.killpoint?.("before_response_write");
  const applied = readDocReceipt(input, decision.event); input.killpoint?.("after_response_write"); recycleClaims(input.rootDir, intent); return applied;
}

function readAction(input: Input): WriteReceipt {
  const rawPaths = input.action.kind === "doc-show" ? [input.action.path] : input.action.paths;
  if (!exact(input.action, input.action.kind === "doc-show" ? ["kind", "path"] : ["kind", "paths"]) || !Array.isArray(rawPaths) || !rawPaths.length || rawPaths.some((item) => typeof item !== "string")) throw coded("invalid_command", `${input.action.kind} requires valid doc-sync paths`);
  let paths; try { paths = rawPaths.map((item) => documentPath(String(item))); } catch { throw coded("invalid_command", `${input.action.kind} requires valid doc-sync paths`); }
  if (!directPaths(input.rootDir, paths) || paths.some((candidate) => !resolveDocRoute(candidate).allowed)) throw coded("invalid_command", `${input.action.kind} requires valid doc-sync paths`);
  const current = input.store.currentCommit(), lease = input.binding.assignmentScope ? input.projection.currentLeaseForExecution(input.binding.assignmentScope.executionId, input.now()) : null;
  const scope = scopeTouches(input, paths); if (scope.length) return reject(`read:${input.action.kind}:${current.sha}`, "assignment_scope_mismatch", readDetail(input, paths, current, lease, scope), "read only paths in the authenticated assignment scope");
  const reads = paths.map((candidate) => input.projection.readDocument(candidate)), revision = input.store.readHead()?.revision ?? 0, ready = reads.every((read) => read.status === "ready");
  const receiptDetail = readDetail(input, paths, current, lease, []), worktreeVisible = observe(input.rootDir, input.binding.source, reads.map((read) => read.document));
  if (input.action.kind === "doc-show" && ready && reads[0]?.document === null) return reject(`read:doc-show:${current.sha}`, "document_not_found", receiptDetail, "sync the document before showing it");
  const evidence = input.action.kind === "doc-show" ? reads[0]?.document?.body ?? "document:not-found" : `document-cut:${current.sha}`;
  return ready ? { outcome: "applied", opId: `read:${input.action.kind}:${current.sha}`, revision, evidence, visibility: "center", proof: proof(revision, revision, true, worktreeVisible), detail: receiptDetail }
    : { outcome: "pending", opId: `read:${input.action.kind}:${current.sha}`, revision, evidence, visibility: "center", proof: proof(revision, Math.min(...reads.map((read) => read.watermark)), false, worktreeVisible), detail: receiptDetail, nextAction: receiptDetail.nextAction };
}

export function readDocReceipt(input: Omit<Input, "action">, event: DocEventV1): WriteReceipt {
  const reads = event.payload.changes.map((change) => input.projection.readDocument(change.path)), canonicalVisible = reads.every((read, index) => read.status === "ready" && read.document?.blobSha256 === event.payload.changes[index]!.candidate.sha256 && read.watermark >= event.workspaceRevision), appliedCut = Math.min(...reads.map((read) => read.watermark)), current = input.store.currentCommit(), lease = input.projection.currentLeaseForExecution(event.payload.executionId, input.now());
  const receiptDetail: DocSyncReceiptDetail = { kind: "doc_sync", code: canonicalVisible ? "applied" : "projection_pending", baseLedgerSha: event.payload.baseLedgerSha.sha, currentLedgerSha: current.sha,
    paths: event.payload.changes.map((change, index) => ({ path: change.path, baseBlobSha256: change.baseBlobSha256, currentBlobSha256: reads[index]?.document?.blobSha256 ?? null, candidateBlobSha256: change.candidate.sha256 })), holder: holder(lease), differences: [], unresolvedTouches: [], deletions: [], nextAction: canonicalVisible ? "no action required" : "retry receipt show after projection catch-up" };
  const common = { opId: event.opId, revision: event.workspaceRevision, evidence: `event-object:${event.opId}`, visibility: "center" as const, proof: proof(event.workspaceRevision, appliedCut, canonicalVisible, observe(input.rootDir, input.binding.source, reads.map((read) => read.document))), detail: receiptDetail };
  return canonicalVisible ? { outcome: "applied", ...common } : { outcome: "pending", ...common, nextAction: receiptDetail.nextAction };
}

export function applyDocReplicaAck(receipt: WriteReceipt, viewId: string, ackCut: number): WriteReceipt {
  if (!receipt.proof || receipt.revision === undefined || receipt.visibility !== "center") throw coded("invalid_ack", "replica ACK requires a center visibility receipt");
  const exactAck = receipt.outcome === "applied" && receipt.proof.durable && receipt.proof.canonicalVisible && ackCut === receipt.revision;
  const common = { ...receipt, visibility: { kind: "replica" as const, viewId }, proof: { ...receipt.proof, ackCut, worktreeVisible: exactAck } };
  return exactAck ? common : { ...common, outcome: "pending", nextAction: `wait for replica ${viewId} ACK at revision ${receipt.revision}` };
}
export function readProjectedDocument(projection: TaskProjection, payload: Readonly<Record<string, unknown>>) { const taskId = requiredString(payload.taskId, "taskId"), requested = requiredString(payload.path, "path"), read = projection.readDocument(documentPath(`tasks/${taskId}/${requested}`));
  return { ok: true as const, status: read.status, taskId, path: requested, body: read.document?.body ?? "", blobSha256: read.document?.blobSha256 ?? null, watermark: read.watermark, sourceRevision: read.sourceRevision }; }

function intentFrom(input: Input): DocWriteIntent {
  try { let changes: unknown = input.action.changes;
    if (input.binding.source === "local") { if (!exact(input.action, ["kind", "executionId", "baseLedgerSha", "selections"]) || !Array.isArray(input.action.selections)) throw new Error("local doc submit requires descriptor-only selections");
      changes = input.action.selections.map((selection) => localChange(input.rootDir, selection)); }
    else if (!exact(input.action, ["kind", "executionId", "baseLedgerSha", "changes"])) throw new Error("assignment doc submit requires staged claim descriptors");
    const intent = parseDocWriteIntent({ schema: "doc-write-intent/v1", executionId: input.action.executionId, baseLedgerSha: input.action.baseLedgerSha, changes }, input.workspaceId);
    if (!directPaths(input.rootDir, intent.changes.map((change) => change.path))) throw new Error("document path contains a symbolic link"); return intent;
  } catch (error) { throw coded("invalid_command", error instanceof Error ? error.message : String(error)); }
}
function localChange(rootDir: string, value: unknown): unknown { if (!value || typeof value !== "object" || !exact(value as Action, ["path", "baseBlobSha256"])) throw new Error("local selection requires path and baseBlobSha256");
  const selection = value as { readonly path: string; readonly baseBlobSha256: string | null }, logical = documentPath(selection.path), target = path.join(resolveHarnessLayout(rootDir).authoredRoot, logical);
  if (!directPaths(rootDir, [logical]) || !existsSync(target) || !lstatSync(target).isFile()) return { path: logical, baseBlobSha256: selection.baseBlobSha256, policyId: DOC_POLICY_ID, candidate: null };
  const bytes = readFileSync(target), hash = sha256Bytes(bytes), ref = `doc-sync-claims/${hash}`; writeClaim(rootDir, ref, bytes);
  return { path: logical, baseBlobSha256: selection.baseBlobSha256, policyId: DOC_POLICY_ID, candidate: { ref, sha256: hash, size: bytes.byteLength, mediaType: logical.endsWith(".md") ? "text/markdown" : "text/plain" } };
}
function admissionRejection(input: Input, intent: DocWriteIntent, lease: ReturnType<TaskProjection["currentLeaseForExecution"]>): { readonly code: string; readonly detail: DocSyncReceiptDetail } | null {
  if (input.binding.docWriteAllowed === false) { const rejected = detail(intent, input.store.currentCommit(), "rbac_forbidden", lease, intent.changes.map((change) => touch(change.path, "repo-write", "principal lacks repo-write")));
    return { code: "rbac_forbidden", detail: { ...rejected, nextAction: "use a repo-write principal holding the active execution lease" } }; }
  const scope = input.binding.assignmentScope, identityMismatch = scope && (scope.executionId !== intent.executionId || scope.taskId !== lease?.taskId);
  const touches = identityMismatch ? intent.changes.map((change) => touch(change.path, `assignment:${scope.executionId}:${scope.taskId}`, "task or execution is outside the authenticated assignment scope")) : scopeTouches(input, intent.changes.map((change) => change.path)); if (!touches.length) return null;
  const rejected = detail(intent, input.store.currentCommit(), "assignment_scope_mismatch", lease, touches); return { code: "assignment_scope_mismatch", detail: { ...rejected, nextAction: "submit only paths in the authenticated assignment scope" } };
}
function scopeTouches(input: Pick<Input, "binding" | "workspaceId">, paths: readonly string[]) { if (input.binding.source === "local") return [];
  const scope = input.binding.assignmentScope, assignmentId = typeof input.binding.source === "object" ? input.binding.source.assignmentId : "remote-direct", route = `assignment:${assignmentId}:${scope?.paths.join(",") ?? "scope-missing"}`;
  return paths.filter((candidate) => !scope || scope.repoId !== input.workspaceId || !scope.paths.some((allowed) => candidate === allowed || candidate.startsWith(`${allowed}/`))).map((candidate) => touch(candidate, route, "path is outside the authenticated assignment scope")); }
function readDetail(input: Input, paths: readonly string[], current: LedgerCommitSha, lease: ReturnType<TaskProjection["currentLeaseForExecution"]>, unresolvedTouches: DocSyncReceiptDetail["unresolvedTouches"]): DocSyncReceiptDetail { const reads = paths.map((candidate) => input.projection.readDocument(candidate));
  return { kind: "doc_sync", code: unresolvedTouches.length ? "assignment_scope_mismatch" : input.action.kind, baseLedgerSha: current.sha, currentLedgerSha: current.sha,
    paths: reads.map((read, index) => ({ path: paths[index]!, baseBlobSha256: read.document?.blobSha256 ?? null, currentBlobSha256: read.document?.blobSha256 ?? null, candidateBlobSha256: null })), holder: holder(lease), differences: [], unresolvedTouches, deletions: [], nextAction: reads.every((read) => read.status === "ready") ? "submit against this base cut" : "retry after projection catch-up" }; }
function detail(intent: DocWriteIntent, current: LedgerCommitSha, code: string, lease: ReturnType<TaskProjection["currentLeaseForExecution"]>, unresolvedTouches: DocSyncReceiptDetail["unresolvedTouches"] = []): DocSyncReceiptDetail { return { kind: "doc_sync", code,
  baseLedgerSha: intent.baseLedgerSha.sha, currentLedgerSha: current.sha, paths: intent.changes.map((change) => ({ path: change.path, baseBlobSha256: change.baseBlobSha256, currentBlobSha256: null, candidateBlobSha256: change.candidate?.sha256 ?? null })), holder: holder(lease), differences: [], unresolvedTouches, deletions: [], nextAction: "refresh status and resubmit with a new opId" }; }
function touch(pathValue: string, requiredRoute: string, reason: string): DocSyncReceiptDetail["unresolvedTouches"][number] { return { path: pathValue, regionId: null, anchor: null, reason, requiredRoute, policy: DOC_POLICY_ID }; }
function holder(lease: ReturnType<TaskProjection["currentLeaseForExecution"]>): DocSyncReceiptDetail["holder"] { return lease && { taskId: lease.taskId, executionId: lease.executionId, personId: lease.actor.principal.personId, executorId: lease.actor.executor?.id ?? null, source: lease.source, expiresAt: lease.expiresAt, version: lease.version }; }
function writeClaim(rootDir: string, ref: string, bytes: Uint8Array): void { const claims = path.join(resolveHarnessLayout(rootDir).localRoot, "doc-sync-claims"); if (existsSync(claims) && lstatSync(claims).isSymbolicLink()) throw new Error("claim root cannot be a symbolic link"); mkdirSync(claims, { recursive: true }); writeFileSync(path.join(resolveHarnessLayout(rootDir).localRoot, ref), bytes); }
function claimBytes(rootDir: string, ref: DocClaimRef): Uint8Array | null { const target = claimFile(rootDir, ref); return target && lstatSync(target).isFile() ? readFileSync(target) : null; }
function claimFile(rootDir: string, ref: string): string | null { let target = resolveHarnessLayout(rootDir).localRoot; if (existsSync(target) && lstatSync(target).isSymbolicLink()) return null;
  for (const segment of ref.split("/")) { target = path.join(target, segment); if (!existsSync(target) || lstatSync(target).isSymbolicLink()) return null; } return target; }
function recycleClaims(rootDir: string, intent: DocWriteIntent): void { for (const change of intent.changes) { const target = change.candidate && claimFile(rootDir, change.candidate.ref); if (target) unlinkSync(target); } }
function directPaths(rootDir: string, paths: readonly string[]): boolean { const authored = resolveHarnessLayout(rootDir).authoredRoot; if (existsSync(authored) && lstatSync(authored).isSymbolicLink()) return false;
  return paths.every((document) => { let target = authored; for (const segment of document.split("/")) { target = path.join(target, segment); if (existsSync(target) && lstatSync(target).isSymbolicLink()) return false; } return true; }); }
function observe(rootDir: string, source: WriteSource, documents: readonly ({ readonly path: string; readonly blobSha256: string } | null)[]): boolean | null { if (source !== "local" || documents.some((document) => document === null)) return null;
  const authored = resolveHarnessLayout(rootDir).authoredRoot; return documents.every((document) => { const target = path.join(authored, document!.path); return existsSync(target) && sha256Bytes(readFileSync(target)) === document!.blobSha256; }); }
function matches(event: DocEventV1, intent: DocWriteIntent, actor: ActorIdentity, source: WriteSource): boolean { return event.payload.executionId === intent.executionId && stableStringify(event.payload.baseLedgerSha) === stableStringify(intent.baseLedgerSha) && stableStringify(event.actor) === stableStringify(actor) && stableStringify(event.source) === stableStringify(source) && stableStringify(event.payload.changes.map((change) => ({ path: change.path, baseBlobSha256: change.baseBlobSha256, policyId: change.policyId, candidate: change.candidate }))) === stableStringify(intent.changes.map((change) => ({ path: change.path, baseBlobSha256: change.baseBlobSha256, policyId: change.policyId, candidate: change.candidate && { sha256: change.candidate.sha256, size: change.candidate.size, mediaType: change.candidate.mediaType } }))); }
function proof(committedRevision: number, appliedCut: number, canonicalVisible: boolean, worktreeVisible: boolean | null) { return { committedRevision, appliedCut, durable: true, canonicalVisible, worktreeVisible }; }
function reject(opId: string, code: string, receiptDetail: DocSyncReceiptDetail, nextAction: string): WriteReceipt { return { outcome: "rejected", opId, code, origin: "doc-sync-contract", evidence: `contract-rejection:${code}`, nextAction, detail: receiptDetail }; }
function requiredString(value: unknown, name: string): string { if (typeof value === "string" && value.trim()) return value; throw coded("invalid_command", `${name} is required`); }
function exact(value: Action, fields: readonly string[]): boolean { return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field)); }
function coded(code: string, message: string): Error { const error = new Error(message) as Error & { code: string }; error.code = code; return error; }
