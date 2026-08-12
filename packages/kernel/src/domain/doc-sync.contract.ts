import { sha256Bytes, sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { validateTaskEvent, type TaskEventV1 } from "./task-lifecycle.contract.ts";
import { freezeDeclaredWritePlan, hasOnlyFields, isNonEmptyString, isRecord, serializeEventEnvelope,
  type ActorIdentity, type EventEnvelope, type FrozenWritePlan, type WriteSource, type WriteTarget } from "./write-chain.contract.ts";
import type { DocSyncDifference, DocSyncReceiptDetail, DocSyncUnresolvedTouch } from "./receipt-domain-registry.ts";
import type { LeaseV1 } from "./execution.ts";

export const DOC_POLICY_ID = "markdown-additive/v1", DOC_CODEC_ID = "markdown-regions/v1";
export const docRouteRegistry = Object.freeze([{ prefix: "events/", requiredRoute: "canonical-event" }, { prefix: "objects/", requiredRoute: "content-blob" },
  { prefix: "harness.yaml", requiredRoute: "workspace-config" }, { prefix: "people.yaml", requiredRoute: "people-registry" }] as const);
export const docRegionPolicyRegistry = Object.freeze([{ id: DOC_POLICY_ID, codecId: DOC_CODEC_ID, writable: "equal-or-insert", catchAll: "prose/*" }] as const);
export interface ContentClaim { readonly ref: string; readonly sha256: string; readonly size: number; readonly mediaType: "text/markdown" | "text/plain" }
export interface DocWriteChange { readonly path: string; readonly baseBlobSha256: string | null; readonly policyId: string; readonly candidate: ContentClaim | null }
export interface DocWriteIntent { readonly schema: "doc-write-intent/v1"; readonly executionId: string; readonly baseLedgerSha: string; readonly changes: readonly DocWriteChange[] }
export interface RegionProof { readonly regionId: string; readonly policyId: string; readonly codecId: string; readonly baseSha256: string; readonly candidateSha256: string; readonly insertBytes: number }
export interface DocEventChange { readonly path: string; readonly baseBlobSha256: string | null; readonly candidate: Omit<ContentClaim, "ref">; readonly policyId: string; readonly regionProofs: readonly RegionProof[] }
export type DocEventV1 = EventEnvelope<"doc-event/v1", "documents_written", ActorIdentity, { readonly executionId: string; readonly baseLedgerSha: string; readonly changes: readonly DocEventChange[] }>;
export type CanonicalEventV1 = TaskEventV1 | DocEventV1;
export interface DocumentState { readonly path: string; readonly blobSha256: string; readonly body: string; readonly size: number; readonly mediaType: string; readonly policyId: string; readonly workspaceRevision: number }
export interface DocContentBlob { readonly sha256: string; readonly size: number; readonly mediaType: string; readonly body: string }
export interface DocWriteDecisionInput { readonly intent: DocWriteIntent; readonly opId: string; readonly eventId: string; readonly workspaceRevision: number; readonly actor: ActorIdentity; readonly source: WriteSource; readonly occurredAt: string; readonly currentLedgerSha: string; readonly lease: LeaseV1 | null; readonly documents: readonly (DocumentState | null)[]; readonly claims: readonly (Uint8Array | null)[] }
export type DocWriteDecision = { readonly accepted: true; readonly event: DocEventV1; readonly blobs: readonly DocContentBlob[]; readonly plan: FrozenWritePlan<"DocSyncSubmit"> }
  | { readonly accepted: false; readonly code: string; readonly detail: DocSyncReceiptDetail };

export function validateDocWriteIntent(value: unknown): readonly string[] {
  if (!isRecord(value) || !hasOnlyFields(value, ["schema", "executionId", "baseLedgerSha", "changes"])) return ["doc intent fields are incomplete or unknown"];
  const errors: string[] = [];
  if (value.schema !== "doc-write-intent/v1" || !isNonEmptyString(value.executionId) || !commitSha(value.baseLedgerSha) || !Array.isArray(value.changes) || value.changes.length === 0) errors.push("doc intent identity, base, or changes are invalid");
  const paths = new Set<string>();
  for (const change of Array.isArray(value.changes) ? value.changes : []) {
    if (!isRecord(change) || !hasOnlyFields(change, ["path", "baseBlobSha256", "policyId", "candidate"]) || !safePath(change.path) || !nullableBlobSha(change.baseBlobSha256) || !isNonEmptyString(change.policyId) || !validClaim(change.candidate)) errors.push("doc change path, base, policy, or claim is invalid");
    else if (paths.has(change.path)) errors.push(`duplicate doc path ${change.path}`); else paths.add(change.path);
  }
  return errors;
}
export const canonicalEventSchemas = Object.freeze([{ schema: "task-event/v1", validate: (value: unknown) => validateTaskEvent(value).map((issue) => issue.message) },
  { schema: "doc-event/v1", validate: validateDocEvent }] as const);
export function serializeCanonicalEvent(event: CanonicalEventV1): string { const entry = canonicalEventSchemas.find((candidate) => candidate.schema === event.schema); const errors = entry?.validate(event) ?? ["canonical event schema is unknown"]; if (errors.length) throw new Error(errors.join("; ")); return serializeEventEnvelope(event); }
export function parseCanonicalEvent(body: string): CanonicalEventV1 { let value: unknown; try { value = JSON.parse(body); } catch { throw new Error("canonical event is not JSON"); }
  if (!isRecord(value)) throw new Error("canonical event is not an object"); const entry = canonicalEventSchemas.find((candidate) => candidate.schema === value.schema); const errors = entry?.validate(value) ?? ["canonical event schema is unknown"];
  if (errors.length) throw new Error(errors.join("; ")); const event = value as unknown as CanonicalEventV1; if (serializeCanonicalEvent(event) !== body) throw new Error("canonical event bytes are not canonical"); return event; }
export function isTaskEvent(event: CanonicalEventV1): event is TaskEventV1 { return event.schema === "task-event/v1"; }
export function isDocEvent(event: CanonicalEventV1): event is DocEventV1 { return event.schema === "doc-event/v1"; }

export function decideDocWrite(input: DocWriteDecisionInput): DocWriteDecision {
  const paths = input.intent.changes.map((change, index) => ({ path: change.path, baseBlobSha256: change.baseBlobSha256,
    currentBlobSha256: input.documents[index]?.blobSha256 ?? null, candidateBlobSha256: change.candidate?.sha256 ?? null }));
  const holder = input.lease === null ? null : { taskId: input.lease.taskId, executionId: input.lease.executionId, personId: input.lease.actor.principal.personId,
    executorId: input.lease.actor.executor?.id ?? null, source: input.lease.source, expiresAt: input.lease.expiresAt, version: input.lease.version };
  const differences: DocSyncDifference[] = [], unresolvedTouches: DocSyncUnresolvedTouch[] = [], deletions: { path: string; baseBlobSha256: string; source: "intent" }[] = [], changes: DocEventChange[] = [], blobs: DocContentBlob[] = [];
  const reject = (code: string, nextAction: string): DocWriteDecision => ({ accepted: false, code, detail: { kind: "doc_sync", code,
    baseLedgerSha: input.intent.baseLedgerSha, currentLedgerSha: input.currentLedgerSha, paths, holder, differences, unresolvedTouches, deletions, nextAction } });
  if (input.lease === null || input.lease.phase !== "active" || input.lease.executionId !== input.intent.executionId || !sameActor(input.lease.actor, input.actor) || stableStringify(input.lease.source) !== stableStringify(input.source)) return reject("lease_conflict", "refresh status and submit while holding the matching execution lease");
  if (input.intent.baseLedgerSha !== input.currentLedgerSha) return reject("base_ledger_changed", "refresh status/base and resubmit with a new opId");
  for (const [index, change] of input.intent.changes.entries()) {
    const current = input.documents[index] ?? null, route = resolveDocRoute(change.path), task = taskFromPath(change.path);
    if (task !== null && task !== input.lease.taskId) unresolvedTouches.push(touch(change.path, null, "target task does not match the execution lease", "matching-task-lease"));
    if (!route.allowed) unresolvedTouches.push(touch(change.path, null, "path is owned by a typed route", route.requiredRoute));
    if (change.baseBlobSha256 !== (current?.blobSha256 ?? null)) return reject("base_blob_changed", "refresh the changed document base and resubmit with a new opId");
    if (change.policyId !== DOC_POLICY_ID || current !== null && current.policyId !== change.policyId) return reject("semantic_policy_changed", "refresh status after the region policy change");
    if (change.candidate === null) { if (change.baseBlobSha256 !== null) deletions.push({ path: change.path, baseBlobSha256: change.baseBlobSha256, source: "intent" }); continue; }
    const claim = input.claims[index]; if (claim === null || claim.byteLength !== change.candidate.size || sha256Bytes(claim ?? new Uint8Array()) !== change.candidate.sha256) return reject("content_claim_mismatch", "upload a claim whose hash and size match the descriptor");
    let body: string; try { body = new TextDecoder("utf-8", { fatal: true }).decode(claim); } catch (error) { consumeKnownError(error); unresolvedTouches.push(touch(change.path, null, "claim is not valid UTF-8", "typed-binary-content")); continue; }
    if (body.includes("\r")) { unresolvedTouches.push(touch(change.path, null, "claim is not canonical LF text", "canonical-utf8-prose")); continue; }
    const semantic = additiveProof(change.path, current?.body ?? "", body, change.candidate.mediaType); differences.push(...semantic.differences); unresolvedTouches.push(...semantic.unresolved);
    changes.push({ path: change.path, baseBlobSha256: change.baseBlobSha256, candidate: { sha256: change.candidate.sha256, size: change.candidate.size, mediaType: change.candidate.mediaType }, policyId: change.policyId, regionProofs: semantic.proofs });
    blobs.push({ sha256: change.candidate.sha256, size: change.candidate.size, mediaType: change.candidate.mediaType, body });
  }
  if (deletions.length) return reject("deletion_forbidden", "restore deleted prose and submit additive changes with a new opId");
  if (unresolvedTouches.length) return reject("unresolved_touch", "resolve denied, ambiguous, non-additive, or machine-owned touches before resubmitting");
  const event: DocEventV1 = { schema: "doc-event/v1", eventId: input.eventId, workspaceRevision: input.workspaceRevision, opId: input.opId,
    type: "documents_written", actor: input.actor, source: input.source, occurredAt: input.occurredAt, payload: { executionId: input.intent.executionId, baseLedgerSha: input.intent.baseLedgerSha, changes } };
  return { accepted: true, event, blobs, plan: docSyncWritePlan(event) };
}
export function docSyncWritePlan(event: DocEventV1): FrozenWritePlan<"DocSyncSubmit"> {
  const targets: WriteTarget[] = [{ kind: "event_file", path: `harness/events/${event.opId}.json`, operation: "create" }, { kind: "event_head", path: "harness/events/head.json", operation: "replace" }];
  for (const change of event.payload.changes) targets.push({ kind: "projection_invalidation", projection: "document/v1", key: change.path }, { kind: "content_blob", sha256: change.candidate.sha256, size: change.candidate.size, mediaType: change.candidate.mediaType });
  return freezeDeclaredWritePlan({ commandType: "DocSyncSubmit", targets }, ["DocSyncSubmit"]);
}
export function resolveDocRoute(path: string): { readonly allowed: boolean; readonly requiredRoute: string } { if (!safePath(path)) return { allowed: false, requiredRoute: "valid-authored-path" };
  const denied = docRouteRegistry.find((route) => path === route.prefix || path.startsWith(route.prefix)); return denied ? { allowed: false, requiredRoute: denied.requiredRoute } : { allowed: true, requiredRoute: "doc-sync" }; }
export function verifyDocEventChange(change: DocEventChange, baseBody: string, candidateBody: string): boolean { const compiled = additiveProof(change.path, baseBody, candidateBody, change.candidate.mediaType); return compiled.unresolved.length === 0 && stableStringify(compiled.proofs) === stableStringify(change.regionProofs); }

function validateDocEvent(value: unknown): readonly string[] { if (!isRecord(value) || !hasOnlyFields(value, ["schema", "eventId", "workspaceRevision", "opId", "type", "actor", "source", "occurredAt", "payload"]) || value.schema !== "doc-event/v1" || value.type !== "documents_written" || !isRecord(value.payload) || !hasOnlyFields(value.payload, ["executionId", "baseLedgerSha", "changes"]) || !isNonEmptyString(value.payload.executionId) || !commitSha(value.payload.baseLedgerSha) || !Array.isArray(value.payload.changes) || value.payload.changes.length === 0) return ["doc event envelope or payload is invalid"];
  try { serializeEventEnvelope(value as unknown as DocEventV1); } catch { return ["doc event envelope identity is invalid"]; }
  const valid = value.payload.changes.every((change) => isRecord(change) && hasOnlyFields(change, ["path", "baseBlobSha256", "candidate", "policyId", "regionProofs"]) && safePath(change.path) && nullableBlobSha(change.baseBlobSha256) && change.policyId === DOC_POLICY_ID && validStoredClaim(change.candidate) && Array.isArray(change.regionProofs) && change.regionProofs.length > 0 && change.regionProofs.every(validRegionProof)), paths = value.payload.changes.map((change) => isRecord(change) ? change.path : null); return valid && new Set(paths).size === paths.length ? [] : ["doc event change is invalid"]; }
function validClaim(value: unknown): boolean { return value === null || isRecord(value) && hasOnlyFields(value, ["ref", "sha256", "size", "mediaType"]) && isNonEmptyString(value.ref) && validStoredClaim(value); }
function validStoredClaim(value: unknown): boolean { return isRecord(value) && /^[0-9a-f]{64}$/u.test(String(value.sha256)) && Number.isInteger(value.size) && (value.size as number) >= 0 && (value.mediaType === "text/markdown" || value.mediaType === "text/plain"); }
function validRegionProof(value: unknown): boolean { return isRecord(value) && hasOnlyFields(value, ["regionId", "policyId", "codecId", "baseSha256", "candidateSha256", "insertBytes"]) && isNonEmptyString(value.regionId) && value.policyId === DOC_POLICY_ID && value.codecId === DOC_CODEC_ID && [value.baseSha256, value.candidateSha256].every((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/u.test(hash)) && Number.isInteger(value.insertBytes) && (value.insertBytes as number) >= 0; }
function commitSha(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value); }
function nullableBlobSha(value: unknown): boolean { return value === null || typeof value === "string" && /^[0-9a-f]{64}$/u.test(value); }
function safePath(value: unknown): value is string { return isNonEmptyString(value) && !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part && part !== "." && part !== ".."); }
function sameActor(left: ActorIdentity, right: ActorIdentity): boolean { return left.principal.personId === right.principal.personId && left.executor?.id === right.executor?.id; }
function taskFromPath(value: string): string | null { const match = /^tasks\/([^/]+)\//u.exec(value); if (!match) return null; const folder = match[1]!; return /^task_[0-9A-HJKMNP-TV-Z]{26}(?:-|$)/u.test(folder) ? folder.slice(0, 31) : folder; }
function touch(path: string, regionId: string | null, reason: string, requiredRoute: string): DocSyncUnresolvedTouch { return { path, regionId, anchor: regionId, reason, requiredRoute, policy: DOC_POLICY_ID }; }
function consumeKnownError(error: unknown): void { void error; }

interface Region { readonly id: string; readonly mode: "additive" | "equal"; readonly body: string; readonly offset: number }
function additiveProof(path: string, base: string, candidate: string, mediaType: string): { readonly proofs: readonly RegionProof[]; readonly differences: readonly DocSyncDifference[]; readonly unresolved: readonly DocSyncUnresolvedTouch[] } {
  const left = base === "" ? { regions: [] as readonly Region[], error: null } : regions(base, mediaType), right = regions(candidate, mediaType); if (left.error || right.error) return { proofs: [], differences: [], unresolved: [touch(path, null, left.error ?? right.error ?? "ambiguous region", "refresh-region-policy")] };
  const rightById = new Map(right.regions.map((region) => [region.id, region])), proofs: RegionProof[] = [], differences: DocSyncDifference[] = [], unresolved: DocSyncUnresolvedTouch[] = []; let order = -1;
  for (const region of left.regions) { const next = rightById.get(region.id), nextOrder = right.regions.findIndex((candidateRegion) => candidateRegion.id === region.id); if (!next || nextOrder < order) { unresolved.push(touch(path, region.id, "base region is missing or reordered", "refresh-region-policy")); continue; } order = nextOrder;
    const result = compareRegion(path, region, next); proofs.push(result.proof); if (result.difference) differences.push(result.difference); if (!result.allowed) unresolved.push(touch(path, region.id, region.mode === "equal" ? "machine region changed" : "region contains delete or replace", "additive-only")); }
  for (const region of right.regions) if (!left.regions.some((candidateRegion) => candidateRegion.id === region.id)) { if (region.mode === "equal") unresolved.push(touch(path, region.id, "new machine region is forbidden", "typed-machine-writer")); else proofs.push(proof(region.id, "", region.body)); }
  return { proofs, differences, unresolved };
}
function regions(body: string, mediaType: string): { readonly regions: readonly Region[]; readonly error: string | null } { if (mediaType === "text/plain") return { regions: [{ id: "prose/*", mode: "additive", body, offset: 0 }], error: null };
  const result: Region[] = []; let prose = body, offset = 0; if (body.startsWith("---\n")) { const end = body.indexOf("\n---\n", 4); if (end < 0) return { regions: [], error: "unterminated frontmatter" }; const length = end + 5; result.push({ id: "machine/frontmatter", mode: "equal", body: body.slice(0, length), offset: 0 }); prose = body.slice(length); offset = length; }
  const matches = [...prose.matchAll(/^#{1,6} +(.+)$/gmu)]; const ids = matches.map((match) => `heading/${match[1]!.trim().toLowerCase()}`); if (new Set(ids).size !== ids.length) return { regions: [], error: "duplicate heading anchor" };
  if (!matches.length) result.push({ id: "prose/*", mode: "additive", body: prose, offset }); else { if ((matches[0]!.index ?? 0) > 0) result.push({ id: "prose/*", mode: "additive", body: prose.slice(0, matches[0]!.index), offset });
    matches.forEach((match, index) => { const start = match.index ?? 0, end = matches[index + 1]?.index ?? prose.length; result.push({ id: ids[index]!, mode: "additive", body: prose.slice(start, end), offset: offset + start }); }); }
  return { regions: result, error: null };
}
function compareRegion(path: string, base: Region, candidate: Region): { readonly allowed: boolean; readonly proof: RegionProof; readonly difference: DocSyncDifference | null } { const left = Buffer.from(base.body), right = Buffer.from(candidate.body); let cursor = 0, first = -1;
  for (const byte of right) { if (byte === left[cursor]) cursor += 1; else if (first < 0) first = cursor; } const allowed = base.mode === "equal" ? left.equals(right) : cursor === left.length;
  if (left.equals(right)) return { allowed, proof: proof(base.id, base.body, candidate.body), difference: null }; let prefix = 0; while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  const replaced = allowed ? 0 : Math.min(left.length - prefix, right.length - prefix), deleted = allowed ? 0 : left.length - prefix - replaced;
  return { allowed, proof: proof(base.id, base.body, candidate.body), difference: { path, regionId: base.id, insertBytes: allowed ? right.length - left.length : right.length - prefix - replaced,
    deleteBytes: deleted, replaceBytes: replaced, firstChange: { baseOffset: base.offset + (first < 0 ? prefix : first), candidateOffset: candidate.offset + prefix } } };
}
function proof(regionId: string, base: string, candidate: string): RegionProof { return { regionId, policyId: DOC_POLICY_ID, codecId: DOC_CODEC_ID, baseSha256: sha256Text(base), candidateSha256: sha256Text(candidate), insertBytes: Buffer.byteLength(candidate) - Buffer.byteLength(base) }; }
