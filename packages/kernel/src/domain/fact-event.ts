import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import { freezeDeclaredWritePlan, hasContractFields as matchesFields, isFrozenWritePlan, isNonEmptyString, isRecord, serializeEventEnvelope, validateEventEnvelopeIdentity, type ActorIdentity, type EventEnvelope, type FrozenWritePlan, type WriteTarget } from "./write-chain.contract.ts";
import { codePoints, requiredWithOptional } from "./event-validation.ts";
import { timestamp } from "./timestamp.ts";

export const factConfidenceLevels = ["low", "medium", "high"] as const;
export const factMemoryClasses = ["semantic", "episodic", "procedural"] as const;
export const factMemoryTags = ["episode", "procedural", "tool_memory", "pattern", "task_skill", "abstract_rule", "other"] as const;
export const factProvenanceRuntimes = ["human", "claude-code", "codex", "zcode", "antigravity"] as const;
export type FactConfidence = typeof factConfidenceLevels[number];
export type FactMemoryClass = typeof factMemoryClasses[number];
export type FactMemoryTag = typeof factMemoryTags[number];
export type FactProvenanceRuntime = typeof factProvenanceRuntimes[number];
export const FACT_DOCUMENT_POLICY_ID = "typed-machine-writer/v1" as const;
export interface FactsDocumentClaim { readonly path: string; readonly sha256: string; readonly size: number; readonly mediaType: "text/markdown"; readonly policyId: typeof FACT_DOCUMENT_POLICY_ID }
export interface FactDocumentRecord { readonly factId: string; readonly statement: string; readonly evidenceSource: string; readonly observedAt: string; readonly confidence: FactConfidence; readonly state: "standing" | "superseded_fact"; readonly workspaceRevision: number }
export interface FactContentBlob { readonly sha256: string; readonly size: number; readonly mediaType: "text/markdown"; readonly body: string }

export interface FactEventPayload {
  readonly statement: string;
  readonly evidenceSource: string;
  readonly observedAt: string;
  readonly confidence: FactConfidence;
  readonly memoryClass: FactMemoryClass;
  readonly memoryTags: readonly FactMemoryTag[];
  readonly provenance: readonly { readonly runtime: FactProvenanceRuntime; readonly sessionId: string; readonly boundAt: string }[];
  readonly supersedes?: { readonly factRef: string; readonly rationale: string };
  readonly factsDocumentClaim: FactsDocumentClaim;
}

export type FactEventV1 = EventEnvelope<"fact-event/v1", "fact_recorded", ActorIdentity, FactEventPayload> & {
  readonly taskId: string;
  readonly factId: string;
};
export type FactEventDraftV1 = Omit<FactEventV1, "payload"> & { readonly payload: Omit<FactEventPayload, "factsDocumentClaim"> };
export interface CompiledFactWrite { readonly event: FactEventV1; readonly plan: FrozenWritePlan<"FactRecord">; readonly blobs: readonly [FactContentBlob]; readonly path: string; readonly body: string }

export function compileFactWrite(input: { readonly event: FactEventDraftV1; readonly packagePath: string; readonly currentFacts: readonly FactDocumentRecord[] }): CompiledFactWrite {
  const path = `${input.packagePath}/facts.md`; try { if (normalizeRelativeDocumentPath(path) !== path || !input.packagePath.startsWith(`tasks/${input.event.taskId}-`)) throw new Error(); } catch { throw new Error("facts package path is invalid"); }
  const next: FactDocumentRecord = { factId: input.event.factId, statement: input.event.payload.statement, evidenceSource: input.event.payload.evidenceSource, observedAt: input.event.payload.observedAt, confidence: input.event.payload.confidence, state: "standing", workspaceRevision: input.event.workspaceRevision }, target = input.event.payload.supersedes?.factRef;
  const records = [...input.currentFacts.map((fact) => target?.endsWith(`/${fact.factId}`) ? { ...fact, state: "superseded_fact" as const } : fact), next].sort((left, right) => left.workspaceRevision - right.workspaceRevision || left.factId.localeCompare(right.factId)), body = renderFactsDocument(records), claim: FactsDocumentClaim = { path, sha256: sha256Text(body), size: Buffer.byteLength(body), mediaType: "text/markdown", policyId: FACT_DOCUMENT_POLICY_ID }, event: FactEventV1 = { ...input.event, payload: { ...input.event.payload, factsDocumentClaim: claim } };
  return { event, plan: factWritePlan(event), blobs: [{ sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType, body }], path, body };
}
export function renderFactsDocument(records: readonly FactDocumentRecord[]): string { return `# Facts\n\nManaged by \`ha fact record\`; hand edits are rejected.\n\n## Records\n\n${[...records].sort((left, right) => left.workspaceRevision - right.workspaceRevision || left.factId.localeCompare(right.factId)).map((fact) => `### ${fact.factId}\n\n- Statement: ${escapeFactDocumentScalar(fact.statement)}\n- Evidence source: ${escapeFactDocumentScalar(fact.evidenceSource)}\n- Observed at: ${fact.observedAt}\n- Confidence: ${fact.confidence}\n- State: ${fact.state}\n\n`).join("")}`; }
export function factWritePlan(event: FactEventV1): FrozenWritePlan<"FactRecord"> { const claim = event.payload.factsDocumentClaim, targets: WriteTarget[] = [{ kind: "event_file", path: eventObjectTarget(event.opId), operation: "create" }, { kind: "event_head", path: "harness/events/head.json", operation: "replace" }, { kind: "authored_file", path: claim.path, operation: "replace", sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType }, { kind: "content_blob", sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType }, { kind: "projection_invalidation", projection: "fact/v1", key: event.taskId }, { kind: "projection_invalidation", projection: "document/v1", key: claim.path }]; return freezeDeclaredWritePlan({ commandType: "FactRecord", targets }, ["FactRecord"]); }
export function assertFactWritePlan(event: FactEventV1, plan: FrozenWritePlan | undefined): void { const shape = (value: FrozenWritePlan) => stableStringify({ commandType: value.commandType, targets: value.targets.map(stableStringify).sort() }); if (!plan || !isFrozenWritePlan(plan) || shape(plan) !== shape(factWritePlan(event))) throw new Error("fact write plan must exactly declare event, document, blob, and projections"); }


export function isFactId(value: string): boolean { return /^F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(value); }
export function factRef(taskId: string, factId: string): string { return `fact/${taskId}/${factId}`; }
export function isFactEvent(event: { readonly schema: string }): event is FactEventV1 { return event.schema === "fact-event/v1"; }
export function serializeFactEvent(event: FactEventV1): string { const errors = validateCurrentFactEvent(event); if (errors.length) throw new Error(errors.join("; ")); return serializeEventEnvelope(event); }

export function validateFactEvent(value: unknown): readonly string[] { return validateFactEventFields(value, true); }
export function validateCurrentFactEvent(value: unknown): readonly string[] { return validateFactEventFields(value, false); }
function validateFactEventFields(value: unknown, allowUnknownFields: boolean): readonly string[] {
  if (!isRecord(value) || !matchesFields(value, ["schema", "eventId", "workspaceRevision", "opId", "taskId", "factId", "type", "actor", "source", "occurredAt", "payload"], allowUnknownFields)
    || value.schema !== "fact-event/v1" || value.type !== "fact_recorded" || !safeId(value.taskId) || typeof value.factId !== "string" || !isFactId(value.factId)
    || !timestamp(value.occurredAt) || !isRecord(value.payload) || !requiredWithOptional(value.payload, ["statement", "evidenceSource", "observedAt", "confidence", "memoryClass", "memoryTags", "provenance", "factsDocumentClaim"], ["supersedes"], allowUnknownFields)) return ["fact event envelope or payload is invalid"];
  if (validateEventEnvelopeIdentity(value, allowUnknownFields).length) return ["fact event envelope identity is invalid"];
  const payload = value.payload;
  if (!isNonEmptyString(payload.statement) || !isNonEmptyString(payload.evidenceSource) || !timestamp(payload.observedAt)
    || !includes(factConfidenceLevels, payload.confidence) || !includes(factMemoryClasses, payload.memoryClass)
    || !Array.isArray(payload.memoryTags) || new Set(payload.memoryTags).size !== payload.memoryTags.length || payload.memoryTags.some((tag) => !includes(factMemoryTags, tag))
    || !Array.isArray(payload.provenance) || payload.provenance.length === 0 || payload.provenance.some((entry) => !provenance(entry, allowUnknownFields)) || !uniqueProvenance(payload.provenance)
    || payload.supersedes !== undefined && !supersedes(payload.supersedes, allowUnknownFields) || !validFactsClaim(payload.factsDocumentClaim, value.taskId, allowUnknownFields)) return ["fact event payload is invalid"];
  return [];
}

function validFactsClaim(value: unknown, taskId: unknown, allowUnknownFields: boolean): value is FactsDocumentClaim { if (!isRecord(value) || !matchesFields(value, ["path", "sha256", "size", "mediaType", "policyId"], allowUnknownFields) || !/^[0-9a-f]{64}$/u.test(String(value.sha256)) || !Number.isSafeInteger(value.size) || (value.size as number) < 0 || value.mediaType !== "text/markdown" || value.policyId !== FACT_DOCUMENT_POLICY_ID || typeof taskId !== "string" || !String(value.path).startsWith(`tasks/${taskId}-`) || !String(value.path).endsWith("/facts.md")) return false; try { return normalizeRelativeDocumentPath(String(value.path)) === value.path; } catch { return false; } }
function escapeFactDocumentScalar(value: string): string { return JSON.stringify(value).slice(1, -1); }
function provenance(value: unknown, allowUnknownFields: boolean): boolean { return isRecord(value) && matchesFields(value, ["runtime", "sessionId", "boundAt"], allowUnknownFields)
  && includes(factProvenanceRuntimes, value.runtime) && isNonEmptyString(value.sessionId) && timestamp(value.boundAt); }
function uniqueProvenance(values: readonly unknown[]): boolean { const keys = values.map((value) => isRecord(value) ? `${String(value.runtime)}\0${String(value.sessionId)}` : ""); return new Set(keys).size === keys.length; }
function supersedes(value: unknown, allowUnknownFields: boolean): boolean { return isRecord(value) && matchesFields(value, ["factRef", "rationale"], allowUnknownFields)
  && typeof value.factRef === "string" && /^fact\/[^/]+\/F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(value.factRef) && codePoints(value.rationale, 1, 199); }
function safeId(value: unknown): value is string { return isNonEmptyString(value) && !/[\\/]/u.test(value); }
function includes<const T extends readonly string[]>(values: T, value: unknown): value is T[number] { return typeof value === "string" && (values as readonly string[]).includes(value); }
