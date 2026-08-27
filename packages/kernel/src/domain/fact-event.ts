import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import {
  freezeDeclaredWritePlan,
  hasContractFields as matchesFields,
  isFrozenWritePlan,
  isNonEmptyString,
  isRecord,
  serializeEventEnvelope,
  validateEventEnvelopeIdentity,
  type ActorIdentity,
  type EventEnvelope,
  type FrozenWritePlan,
  type WriteTarget,
} from "./write-chain.contract.ts";
import { codePoints, requiredWithOptional } from "./event-validation.ts";
import { includes } from "./decision-event-validation-shared.ts";
import { timestamp } from "./timestamp.ts";
import { validateSessionIdentity, validateSessionProvenance, type SessionProvenanceV1 } from "./agent-runtime.ts";

export const factConfidenceLevels = ["low", "medium", "high"] as const;
export const factMemoryClasses = ["semantic", "episodic", "procedural"] as const;
export const factMemoryTags = [
  "episode",
  "procedural",
  "tool_memory",
  "pattern",
  "task_skill",
  "abstract_rule",
  "other",
] as const;
export const factProvenanceRuntimes = ["human", "claude-code", "codex", "zcode", "antigravity"] as const;
export type FactConfidence = (typeof factConfidenceLevels)[number];
export type FactMemoryClass = (typeof factMemoryClasses)[number];
export type FactMemoryTag = (typeof factMemoryTags)[number];
export type FactProvenanceRuntime = (typeof factProvenanceRuntimes)[number];
export const FACT_DOCUMENT_POLICY_ID = "typed-machine-writer/v1" as const;
export interface FactsDocumentClaim {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: "text/markdown";
  readonly policyId: typeof FACT_DOCUMENT_POLICY_ID;
}
export interface FactDocumentRecord {
  readonly factId: string;
  readonly statement: string;
  readonly evidenceSource: string;
  readonly observedAt: string;
  readonly confidence: FactConfidence;
  readonly state: "standing" | "superseded_fact";
  readonly workspaceRevision: number;
}
export interface FactContentBlob {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: "text/markdown";
  readonly body: string;
}

export interface FactEventPayload {
  readonly statement: string;
  readonly evidenceSource: string;
  readonly observedAt: string;
  readonly confidence: FactConfidence;
  readonly memoryClass: FactMemoryClass;
  readonly memoryTags: readonly FactMemoryTag[];
  readonly provenance: readonly SessionProvenanceV1[];
  readonly supersedes?: { readonly factRef: string; readonly rationale: string };
  readonly factsDocumentClaim: FactsDocumentClaim;
}

export type FactEventV1 = EventEnvelope<"fact-event/v1", "fact_recorded", ActorIdentity, FactEventPayload> & {
  /** Optional provenance owner. It is not part of fact identity. */
  readonly taskId?: string;
  readonly factId: string;
};
export type FactEventDraftV1 = Omit<FactEventV1, "payload"> & {
  readonly payload: Omit<FactEventPayload, "factsDocumentClaim">;
};
export interface CompiledFactWrite {
  readonly event: FactEventV1;
  readonly plan: FrozenWritePlan<"FactRecord">;
  readonly blobs: readonly [FactContentBlob];
  readonly path: string;
  readonly body: string;
}

export function compileFactWrite(input: { readonly event: FactEventDraftV1 }): CompiledFactWrite {
  const path = `facts/${input.event.factId}.md`;
  try {
    if (normalizeRelativeDocumentPath(path) !== path) throw new Error();
  } catch {
    throw new Error("facts package path is invalid");
  }
  const next: FactDocumentRecord = {
      factId: input.event.factId,
      statement: input.event.payload.statement,
      evidenceSource: input.event.payload.evidenceSource,
      observedAt: input.event.payload.observedAt,
      confidence: input.event.payload.confidence,
      state: "standing",
      workspaceRevision: input.event.workspaceRevision,
    },
    body = renderFactsDocument([next]),
    claim: FactsDocumentClaim = {
      path,
      sha256: sha256Text(body),
      size: Buffer.byteLength(body),
      mediaType: "text/markdown",
      policyId: FACT_DOCUMENT_POLICY_ID,
    },
    event: FactEventV1 = { ...input.event, payload: { ...input.event.payload, factsDocumentClaim: claim } };
  return {
    event,
    plan: factWritePlan(event),
    blobs: [{ sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType, body }],
    path,
    body,
  };
}
export function renderFactsDocument(records: readonly FactDocumentRecord[]): string {
  return `# Facts\n\nManaged by \`ha fact record\`; hand edits are rejected.\n\n## Records\n\n${[...records]
    .sort((left, right) => left.workspaceRevision - right.workspaceRevision || left.factId.localeCompare(right.factId))
    .map(
      (fact) =>
        `### ${fact.factId}\n\n- Statement: ${escapeFactDocumentScalar(fact.statement)}\n- Evidence source: ${escapeFactDocumentScalar(fact.evidenceSource)}\n- Observed at: ${fact.observedAt}\n- Confidence: ${fact.confidence}\n- State: ${fact.state}\n\n`,
    )
    .join("")}`;
}
export function factWritePlan(event: FactEventV1): FrozenWritePlan<"FactRecord"> {
  const claim = event.payload.factsDocumentClaim,
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
      { kind: "projection_invalidation", projection: "fact/v1", key: event.factId },
      { kind: "projection_invalidation", projection: "document/v1", key: claim.path },
    ];
  return freezeDeclaredWritePlan({ commandType: "FactRecord", targets }, ["FactRecord"]);
}
export function assertFactWritePlan(event: FactEventV1, plan: FrozenWritePlan | undefined): void {
  const shape = (value: FrozenWritePlan) =>
    stableStringify({ commandType: value.commandType, targets: value.targets.map(stableStringify).sort() });
  if (!plan || !isFrozenWritePlan(plan) || shape(plan) !== shape(factWritePlan(event)))
    throw new Error("fact write plan must exactly declare event, document, blob, and projections");
}

export function isFactId(value: string): boolean {
  return /^F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(value);
}
export function factRef(factId: string): string {
  return `fact/${factId}`;
}
export function isFactEvent(event: { readonly schema: string }): event is FactEventV1 {
  return event.schema === "fact-event/v1";
}
export function serializeFactEvent(event: FactEventV1): string {
  const errors = validateCurrentFactEvent(event);
  if (errors.length) throw new Error(errors.join("; "));
  return serializeEventEnvelope(event);
}

export function validateFactEvent(value: unknown): readonly string[] {
  return validateFactEventFields(value, true);
}
export function validateCurrentFactEvent(value: unknown): readonly string[] {
  return validateFactEventFields(value, false);
}
function validateFactEventFields(value: unknown, allowUnknownFields: boolean): readonly string[] {
  if (
    !isRecord(value) ||
    !factEventFields(value, allowUnknownFields) ||
    value.schema !== "fact-event/v1" ||
    value.type !== "fact_recorded" ||
    (value.taskId !== undefined && !safeId(value.taskId)) ||
    typeof value.factId !== "string" ||
    !isFactId(value.factId) ||
    !timestamp(value.occurredAt) ||
    !isRecord(value.payload) ||
    !requiredWithOptional(
      value.payload,
      [
        "statement",
        "evidenceSource",
        "observedAt",
        "confidence",
        "memoryClass",
        "memoryTags",
        "provenance",
        "factsDocumentClaim",
      ],
      ["supersedes"],
      allowUnknownFields,
    )
  )
    return ["fact event envelope or payload is invalid"];
  if (validateEventEnvelopeIdentity(value, allowUnknownFields).length)
    return ["fact event envelope identity is invalid"];
  const payload = value.payload;
  if (
    !isNonEmptyString(payload.statement) ||
    !isNonEmptyString(payload.evidenceSource) ||
    !timestamp(payload.observedAt) ||
    !includes(factConfidenceLevels, payload.confidence) ||
    !includes(factMemoryClasses, payload.memoryClass) ||
    !Array.isArray(payload.memoryTags) ||
    new Set(payload.memoryTags).size !== payload.memoryTags.length ||
    payload.memoryTags.some((tag) => !includes(factMemoryTags, tag)) ||
    !Array.isArray(payload.provenance) ||
    payload.provenance.length === 0 ||
    payload.provenance.some((entry) => !provenance(entry, allowUnknownFields)) ||
    !uniqueProvenance(payload.provenance) ||
    (payload.supersedes !== undefined && !supersedes(payload.supersedes, allowUnknownFields)) ||
    !validFactsClaim(payload.factsDocumentClaim, value.factId, value.taskId, allowUnknownFields)
  )
    return ["fact event payload is invalid"];
  return [];
}

function factEventFields(value: Readonly<Record<string, unknown>>, allowUnknownFields: boolean): boolean {
  const required = [
    "schema",
    "eventId",
    "workspaceRevision",
    "opId",
    "factId",
    "type",
    "actor",
    "source",
    "occurredAt",
    "payload",
  ];
  if (allowUnknownFields) return required.every((field) => Object.hasOwn(value, field));
  return (
    Object.keys(value).every((field) => required.includes(field) || field === "taskId") &&
    required.every((field) => Object.hasOwn(value, field))
  );
}

function validFactsClaim(
  value: unknown,
  factId: unknown,
  taskId: unknown,
  allowUnknownFields: boolean,
): value is FactsDocumentClaim {
  const pathIsCanonical =
    typeof factId === "string" && String(value && isRecord(value) ? value.path : "") === `facts/${factId}.md`;
  const pathIsHistoricalTaskLocal =
    allowUnknownFields &&
    typeof taskId === "string" &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).path === "string" &&
    new RegExp(`^tasks/${escapeRegExp(taskId)}-[^/]+/facts\\.md$`, "u").test(
      (value as Record<string, unknown>).path as string,
    );
  if (
    !isRecord(value) ||
    !matchesFields(value, ["path", "sha256", "size", "mediaType", "policyId"], allowUnknownFields) ||
    !/^[0-9a-f]{64}$/u.test(String(value.sha256)) ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0 ||
    value.mediaType !== "text/markdown" ||
    value.policyId !== FACT_DOCUMENT_POLICY_ID ||
    typeof factId !== "string" ||
    (!pathIsCanonical && !pathIsHistoricalTaskLocal)
  )
    return false;
  try {
    return normalizeRelativeDocumentPath(String(value.path)) === value.path;
  } catch {
    return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
function escapeFactDocumentScalar(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}
function provenance(value: unknown, allowUnknownFields: boolean): boolean {
  if (validateSessionProvenance(value)) return timestamp(value.boundAt);
  if (!allowUnknownFields || !isRecord(value)) return false;
  const identity = {
    runtime: value.runtime,
    sessionId: value.sessionId,
    transcriptReachability: value.transcriptReachability,
  };
  return (
    (validateSessionIdentity(identity) && timestamp(value.boundAt)) ||
    (matchesFields(value, ["runtime", "sessionId", "boundAt"], true) &&
      includes(factProvenanceRuntimes, value.runtime) &&
      isNonEmptyString(value.sessionId) &&
      timestamp(value.boundAt))
  );
}
function uniqueProvenance(values: readonly unknown[]): boolean {
  const keys = values.map((value) => (isRecord(value) ? `${String(value.runtime)}\0${String(value.sessionId)}` : ""));
  return new Set(keys).size === keys.length;
}
function supersedes(value: unknown, allowUnknownFields: boolean): boolean {
  if (
    !isRecord(value) ||
    !matchesFields(value, ["factRef", "rationale"], allowUnknownFields) ||
    typeof value.factRef !== "string" ||
    !codePoints(value.rationale, 1, 199)
  ) {
    return false;
  }
  // Pre-fact-first-class events recorded supersedes against the task-scoped
  // identity `fact/<owning-task-id>/F-<id>`; readers accept it until the
  // ledger is rekeyed, the current writer stays canonical-only.
  const historicalTaskScoped = allowUnknownFields && /^fact\/[^/]+\/F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(value.factRef);
  return /^fact\/F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(value.factRef) || historicalTaskScoped;
}
function safeId(value: unknown): value is string {
  return isNonEmptyString(value) && !/[\\/]/u.test(value);
}
