import { Effect, Schema } from "effect";
import {
  DecisionPackageSchema,
  decisionFieldContracts,
  decisionEntityId,
  evaluateEntityDisposition,
  explainDecisionStateTransition,
  validateRelationRecordsForHost,
  type DecisionPackage,
  type DecisionState,
  type EntityRelationRecord,
  type ProvenancePayload,
  type WriteCoordinator,
  type WriteError,
  type WriteOpKind
} from "../../kernel/src/index.ts";
import { harnessRuntimeRoot, type HarnessLayoutInput } from "../../kernel/src/layout/index.ts";
import { stablePayloadHash, writeCoordinatedPayload, type PayloadHasher } from "../../kernel/src/write-coordination/write-helpers.ts";
import { bindCreateProvenance, type ProvenanceBindingOptions } from "./provenance-binding.ts";
import type { ProvenanceSessionExporterRejected } from "./provenance-session-exporter.ts";

export interface DecisionWriteServiceOptions extends ProvenanceBindingOptions {
  readonly coordinator: WriteCoordinator;
  readonly rootInput?: HarnessLayoutInput;
  readonly hashPayload?: PayloadHasher;
  readonly now?: () => string;
}

export interface DecisionWriteRequest {
  readonly decision: DecisionCreateInput;
  readonly body?: string;
  readonly opIdPrefix?: string;
}

export type DecisionCreateInput = Omit<DecisionPackage, "provenance"> & {
  readonly provenance?: DecisionPackage["provenance"];
};

export interface DecisionTransitionRequest {
  readonly current: DecisionPackage;
  readonly arbiter: DecisionPackage["arbiter"];
  readonly decidedAt?: string;
  readonly judgmentOnlyRationale?: string;
  readonly body?: string;
  readonly opIdPrefix?: string;
}

export interface DecisionAmendRequest {
  readonly current: DecisionPackage;
  readonly next: DecisionPackage;
  readonly body?: string;
  readonly opIdPrefix?: string;
}

export interface DecisionRelateRequest {
  readonly current: DecisionPackage;
  readonly relation: EntityRelationRecord;
  readonly body?: string;
  readonly opIdPrefix?: string;
}

export interface DecisionRelationRetireRequest {
  readonly current: DecisionPackage;
  readonly relationId: string;
  readonly body?: string;
  readonly opIdPrefix?: string;
}

export interface DecisionRelationReplaceRequest extends DecisionRelationRetireRequest {
  readonly replacement: EntityRelationRecord;
}

export interface DecisionWriteResult {
  readonly decisionId: string;
  readonly state: DecisionState;
}

export interface DecisionWriteRejected {
  readonly _tag: "DecisionWriteRejected";
  readonly decisionId: string;
  readonly reason: string;
}

export interface DecisionWriteService {
  readonly propose: (request: DecisionWriteRequest) => Effect.Effect<DecisionWriteResult, DecisionWriteRejected | WriteError>;
  readonly accept: (request: DecisionTransitionRequest) => Effect.Effect<DecisionWriteResult, DecisionWriteRejected | WriteError>;
  readonly reject: (request: DecisionTransitionRequest) => Effect.Effect<DecisionWriteResult, DecisionWriteRejected | WriteError>;
  readonly defer: (request: DecisionTransitionRequest) => Effect.Effect<DecisionWriteResult, DecisionWriteRejected | WriteError>;
  readonly supersede: (request: DecisionTransitionRequest) => Effect.Effect<DecisionWriteResult, DecisionWriteRejected | WriteError>;
  readonly amend: (request: DecisionAmendRequest) => Effect.Effect<DecisionWriteResult, DecisionWriteRejected | WriteError>;
  readonly relate: (request: DecisionRelateRequest) => Effect.Effect<DecisionWriteResult, DecisionWriteRejected | WriteError>;
  readonly retireRelation: (request: DecisionRelationRetireRequest) => Effect.Effect<DecisionWriteResult, DecisionWriteRejected | WriteError>;
  readonly replaceRelation: (request: DecisionRelationReplaceRequest) => Effect.Effect<DecisionWriteResult, DecisionWriteRejected | WriteError>;
  readonly retire: (request: DecisionTransitionRequest) => Effect.Effect<DecisionWriteResult, DecisionWriteRejected | WriteError>;
}

export function makeDecisionWriteService(options: DecisionWriteServiceOptions): DecisionWriteService {
  const hashPayload = options.hashPayload ?? stablePayloadHash;
  const timestamp = () => options.now?.() ?? new Date().toISOString();
  return {
    propose: (request) => {
      if (request.decision.state !== "proposed") {
        return Effect.fail(rejection(request.decision.decision_id, "decision_propose requires state proposed"));
      }
      return bindDecisionCreateProvenance(options, request.decision, timestamp()).pipe(
        Effect.catchAll((error) => Effect.fail(rejection(request.decision.decision_id, error.reason))),
        Effect.flatMap((decision) => writeDecision(options.coordinator, hashPayload, "decision_propose", decision, request))
      );
    },
    accept: (request) => transitionDecision(options, hashPayload, "decision_accept", request, "active", timestamp()),
    reject: (request) => transitionDecision(options, hashPayload, "decision_reject", request, "rejected", timestamp()),
    defer: (request) => transitionDecision(options, hashPayload, "decision_defer", request, "deferred", timestamp()),
    // M3 has no separate superseded DecisionState; the distinct op records
    // supersede intent while sharing the retired terminal state.
    supersede: (request) => transitionDecision(options, hashPayload, "decision_supersede", request, "retired", timestamp()),
    amend: (request) => {
      const rejectedChange = firstNonAmendableDecisionChange(request.current, request.next);
      if (rejectedChange) return Effect.fail(rejection(request.current.decision_id, rejectedChange));
      return writeDecision(options.coordinator, hashPayload, "decision_amend", request.next, request, request.current);
    },
    relate: (request) => {
      const next = {
        ...request.current,
        relations: [...request.current.relations, request.relation]
      };
      return writeDecision(options.coordinator, hashPayload, "decision_relate", next, request, request.current);
    },
    retireRelation: (request) => {
      const retired = retireRelationRecord(request.current, request.relationId);
      if (!retired.ok) return Effect.fail(rejection(request.current.decision_id, retired.reason));
      const disposition = assertDispositionAllowed(options, `relation/${request.relationId}`, "retire", request.current.decision_id);
      if (disposition) return Effect.fail(disposition);
      return writeDecision(options.coordinator, hashPayload, "relation_retire", retired.decision, request, request.current);
    },
    replaceRelation: (request) => {
      const retired = retireRelationRecord(request.current, request.relationId);
      if (!retired.ok) return Effect.fail(rejection(request.current.decision_id, retired.reason));
      const disposition = assertDispositionAllowed(options, `relation/${request.relationId}`, "retire", request.current.decision_id);
      if (disposition) return Effect.fail(disposition);
      const next = {
        ...retired.decision,
        relations: [...retired.decision.relations, request.replacement]
      };
      return writeDecision(options.coordinator, hashPayload, "relation_replace", next, request, request.current);
    },
    retire: (request) => transitionDecision(options, hashPayload, "decision_retire", request, "retired", timestamp())
  };
}

function retireRelationRecord(
  current: DecisionPackage,
  relationId: string
): { readonly ok: true; readonly decision: DecisionPackage } | { readonly ok: false; readonly reason: string } {
  const index = current.relations.findIndex((relation) => relation.relation_id === relationId);
  if (index < 0) return { ok: false, reason: `relation not found: ${relationId}` };
  const relation = current.relations[index];
  if (!relation) return { ok: false, reason: `relation not found: ${relationId}` };
  if (relation.state !== "active") return { ok: false, reason: `relation ${relationId} is not active` };
  const relations = current.relations.map((entry, relationIndex) => relationIndex === index ? { ...entry, state: "retired" as const } : entry);
  return { ok: true, decision: { ...current, relations } };
}

function firstNonAmendableDecisionChange(current: DecisionPackage, next: DecisionPackage): string | null {
  for (const field of Object.keys(decisionFieldContracts) as ReadonlyArray<keyof DecisionPackage>) {
    if (sameFieldValue(current[field], next[field])) continue;
    const contract = decisionFieldContracts[field];
    if (contract.mutability === "amendable") continue;
    return `decision_amend cannot change ${contract.mutability} field ${String(field)}${contract.reason ? `: ${contract.reason}` : ""}`;
  }
  return null;
}

function sameFieldValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function bindDecisionCreateProvenance(
  options: DecisionWriteServiceOptions,
  decision: DecisionCreateInput,
  boundAt: string
): Effect.Effect<DecisionPackage, ProvenanceSessionExporterRejected> {
  return bindCreateProvenance(options, boundAt).pipe(
    Effect.map((provenance) => ({
      ...decision,
      provenance: provenance ? [provenance] : existingProvenance(decision)
    }))
  );
}

function existingProvenance(decision: DecisionCreateInput): ReadonlyArray<ProvenancePayload> {
  return decision.provenance ?? [];
}

function transitionDecision(
  options: DecisionWriteServiceOptions,
  hashPayload: PayloadHasher,
  kind: WriteOpKind,
  request: DecisionTransitionRequest,
  to: DecisionState,
  fallbackDecidedAt: string
): Effect.Effect<DecisionWriteResult, DecisionWriteRejected | WriteError> {
  const transition = explainDecisionStateTransition(request.current.state, to);
  if (!transition.allowed) {
    return Effect.fail(rejection(request.current.decision_id, `decision state transition ${request.current.state} -> ${to} rejected: ${transition.reason}`));
  }
  if (kind === "decision_accept" && request.current.state === "proposed") {
    const evidenceFloor = acceptEvidenceFloor(request.current, request.judgmentOnlyRationale);
    if (evidenceFloor) return Effect.fail(evidenceFloor);
  }
  if (kind === "decision_retire") {
    const disposition = assertDispositionAllowed(options, `decision/${request.current.decision_id}`, "retire", request.current.decision_id);
    if (disposition) return Effect.fail(disposition);
  }
  const next: DecisionPackage = {
    ...request.current,
    state: to,
    arbiter: request.arbiter,
    decidedAt: request.decidedAt ?? fallbackDecidedAt
  };
  return writeDecision(options.coordinator, hashPayload, kind, next, {
    ...request,
    body: kind === "decision_accept" ? withJudgmentOnlyBody(request) : request.body
  }, request.current);
}

function acceptEvidenceFloor(decision: DecisionPackage, judgmentOnlyRationale?: string): DecisionWriteRejected | null {
  if (judgmentOnlyRationale?.trim()) return null;
  const claimRefs = new Set(decision.claims.map((claim) => `decision/${decision.decision_id}/${claim.id}`));
  const hasEvidence = decision.relations.some((relation) =>
    relation.state === "active" &&
    claimRefs.has(relation.source) &&
    /^(?:fact\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+|task\/[A-Za-z0-9_-]+|decision\/[A-Za-z0-9_-]+(?:\/[A-Za-z][A-Za-z0-9_-]*)?)$/u.test(relation.target)
  );
  return hasEvidence ? null : rejection(decision.decision_id, "decision_accept requires at least one evidence relation from a claim anchor, or --judgment-only <rationale>");
}

function withJudgmentOnlyBody(request: DecisionTransitionRequest): string | undefined {
  const rationale = request.judgmentOnlyRationale?.trim();
  if (!rationale) return request.body;
  const existing = request.body?.trimEnd() ?? "";
  const section = `## Judgment-only acceptance\n\n${rationale}`;
  return existing ? `${existing}\n\n${section}` : section;
}

function assertDispositionAllowed(
  options: DecisionWriteServiceOptions,
  entityRef: string,
  action: "retire",
  decisionId: string
): DecisionWriteRejected | null {
  if (!options.rootInput) return null;
  const evaluation = evaluateEntityDisposition({
    rootDir: harnessRuntimeRoot(options.rootInput),
    layoutOverrides: typeof options.rootInput === "string" ? undefined : options.rootInput.layoutOverrides,
    entityRef,
    action
  });
  return evaluation.allowed ? null : rejection(decisionId, evaluation.reason);
}

function writeDecision(
  coordinator: WriteCoordinator,
  hashPayload: PayloadHasher,
  kind: WriteOpKind,
  decision: DecisionPackage,
  request: { readonly body?: string; readonly opIdPrefix?: string },
  previous?: DecisionPackage
): Effect.Effect<DecisionWriteResult, DecisionWriteRejected | WriteError> {
  const validation = validateDecisionWrite(decision, previous);
  if (validation) return Effect.fail(validation);
  return writeCoordinatedPayload(coordinator, hashPayload, {
    entityId: decisionEntityId(decision.decision_id),
    kind,
    payload: {
      decision,
      ...(request.body ? { body: request.body } : {})
    },
    ...(request.opIdPrefix ? { opIdPrefix: request.opIdPrefix } : {})
  }).pipe(Effect.as({ decisionId: decision.decision_id, state: decision.state }));
}

function validateDecisionWrite(decision: DecisionPackage, previous?: DecisionPackage): DecisionWriteRejected | null {
  if (sameActor(decision.proposedBy, decision.arbiter)) {
    return rejection(decision.decision_id, "decision arbiter must differ from proposedBy");
  }
  if (decision.rejected.length === 0 || decision.rejected.some((entry) => entry.why_not.trim().length === 0)) {
    return rejection(decision.decision_id, "decision rejected alternatives require non-empty why_not");
  }
  // Delta enforcement: a write must not introduce new relation issues, but is not
  // blocked by pre-existing issues it leaves untouched. Without this, a host holding
  // two or more legacy-illegal edges deadlocks: replacing either edge fails whole-doc
  // validation on the other, so the healing operation is blocked by the disease it
  // exists to fix. Creates (no previous) still enforce the full set fail-closed.
  const relationIssues = validateRelationRecordsForHost(`decision/${decision.decision_id}`, decision.relations);
  const preexisting = previous
    ? new Set(
        validateRelationRecordsForHost(`decision/${previous.decision_id}`, previous.relations)
          .map((issue) => `${issue.code}|${issue.relationId ?? ""}`)
      )
    : new Set<string>();
  const introduced = relationIssues.filter((issue) => !preexisting.has(`${issue.code}|${issue.relationId ?? ""}`));
  if (introduced.length > 0) {
    return rejection(decision.decision_id, introduced.map((issue) => issue.message).join("; "));
  }
  try {
    Schema.decodeUnknownSync(DecisionPackageSchema)(decision);
    return null;
  } catch (error) {
    return rejection(decision.decision_id, error instanceof Error ? error.message : "decision package schema validation failed");
  }
}

function sameActor(left: DecisionPackage["proposedBy"], right: DecisionPackage["arbiter"]): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function rejection(decisionId: string, reason: string): DecisionWriteRejected {
  return { _tag: "DecisionWriteRejected", decisionId, reason };
}
