import { Effect, Schema } from "effect";
import {
  DecisionPackageSchema,
  computeDecisionContentDigest,
  decisionContentCanonicalization,
  decisionFieldContracts,
  decisionEntityId,
  evaluateEntityDisposition,
  explainDecisionStateTransition,
  validateRelationRecordsForHost,
  type DecisionPackage,
  type DecisionState,
  type ActorAxes,
  type AttributionEvent,
  type UnionAttributionEvent,
  type EntityRelationRecord,
  type ProvenancePayload,
  type WriteCoordinator,
  type WriteAttribution,
  type WriteError,
  type WriteOpKind
} from "../../kernel/src/index.ts";
import type { DocumentWrite } from "../../kernel/src/index.ts";
import { readUnionAttributionEvents } from "../../kernel/src/index.ts";
import { harnessRuntimeRoot, type HarnessLayoutInput } from "../../kernel/src/index.ts";
import { stablePayloadHash, writeCoordinatedPayload, type PayloadHasher } from "../../kernel/src/write-coordination/write-helpers.ts";
import { bindCreateProvenance, type ProvenanceBindingOptions } from "./provenance-binding.ts";
import type { ProvenanceSessionExporterRejected } from "./provenance-session-exporter.ts";

export interface DecisionWriteServiceOptions extends ProvenanceBindingOptions {
  readonly coordinator: WriteCoordinator;
  readonly rootInput?: HarnessLayoutInput;
  readonly attribution?: WriteAttribution;
  readonly readAttributionEvents?: () => ReadonlyArray<AttributionEvent>;
  readonly readUnionAttributionEvents?: () => ReadonlyArray<UnionAttributionEvent>;
  readonly hashPayload?: PayloadHasher;
  readonly now?: () => string;
}

export interface DecisionWriteRequest {
  readonly decision: DecisionCreateInput;
  readonly body?: string;
  readonly opIdPrefix?: string;
}

export type DecisionCreateInput = Omit<DecisionPackage, "provenance" | "contentPins"> & {
  readonly provenance?: DecisionPackage["provenance"];
};

export interface DecisionTransitionRequest {
  readonly current: DecisionPackage;
  readonly claims?: DecisionPackage["claims"];
  readonly decisionClass?: DecisionPackage["decisionClass"];
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
  readonly taskWrites?: ReadonlyArray<DocumentWrite>;
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
  readonly taskWrites?: ReadonlyArray<DocumentWrite>;
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
      if ("contentPins" in request.decision) {
        return Effect.fail(rejection(request.decision.decision_id, "decision_propose cannot supply lifecycle-owned contentPins"));
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
      return writeDecision(options.coordinator, hashPayload, "decision_relate", next, request, request.current, {
        kind: "append_relation",
        relation: request.relation
      });
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
  const transitionCurrent: DecisionPackage = {
    ...request.current,
    ...(kind === "decision_accept" && request.decisionClass ? { decisionClass: request.decisionClass } : {}),
    ...(kind === "decision_accept" && request.claims ? { claims: request.claims } : {})
  };
  const transition = explainDecisionStateTransition(request.current.state, to);
  if (!transition.allowed) {
    return Effect.fail(rejection(request.current.decision_id, `decision state transition ${request.current.state} -> ${to} rejected: ${transition.reason}`));
  }
  const independence = assertIndependentJudgmentActor(options, request.current.decision_id);
  if (independence) return Effect.fail(independence);
  if (kind === "decision_accept" && request.current.state === "proposed") {
    const evidenceFloor = acceptEvidenceFloor(transitionCurrent, request.judgmentOnlyRationale);
    if (evidenceFloor) return Effect.fail(evidenceFloor);
  }
  if (kind === "decision_retire") {
    const disposition = assertDispositionAllowed(options, `decision/${request.current.decision_id}`, "retire", request.current.decision_id);
    if (disposition) return Effect.fail(disposition);
  }
  const decidedAt = request.decidedAt ?? fallbackDecidedAt;
  const arbiter = contentPinActor(options.attribution!.actor);
  const next: DecisionPackage = {
    ...transitionCurrent,
    state: to,
    decidedAt,
    contentPins: [
      ...(request.current.contentPins ?? []),
      {
        action: contentPinAction(kind),
        state: to,
        decidedAt,
        arbiter,
        canonicalization: decisionContentCanonicalization,
        digest: computeDecisionContentDigest(transitionCurrent)
      }
    ]
  };
  const judgmentOnlySection = kind === "decision_accept" ? judgmentOnlyBodySection(request) : undefined;
  const explicitBody = request.body !== undefined && judgmentOnlySection
    ? appendSectionToExplicitBody(request.body, judgmentOnlySection)
    : request.body;
  return writeDecision(options.coordinator, hashPayload, kind, next, {
    ...request,
    body: explicitBody
  }, request.current, {
    kind: "snapshot",
    expectedWatermark: request.current._coordinatorWatermark ?? null,
    ...(request.body === undefined && judgmentOnlySection ? { appendBody: judgmentOnlySection } : {})
  });
}

function contentPinAction(kind: WriteOpKind): "accept" | "reject" | "defer" | "supersede" | "retire" {
  switch (kind) {
    case "decision_accept":
      return "accept";
    case "decision_reject":
      return "reject";
    case "decision_defer":
      return "defer";
    case "decision_supersede":
      return "supersede";
    case "decision_retire":
      return "retire";
    default:
      throw new Error(`unsupported decision content pin operation: ${kind}`);
  }
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

function judgmentOnlyBodySection(request: DecisionTransitionRequest): string | undefined {
  const rationale = request.judgmentOnlyRationale?.trim();
  return rationale ? `## Judgment-only acceptance\n\n${rationale}` : undefined;
}

function appendSectionToExplicitBody(body: string, section: string): string {
  const existing = body.trimEnd();
  if (existing.includes(section)) return body;
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
  request: { readonly body?: string; readonly opIdPrefix?: string; readonly taskWrites?: ReadonlyArray<DocumentWrite> },
  previous?: DecisionPackage,
  writeMode?: DecisionDocumentWriteMode
): Effect.Effect<DecisionWriteResult, DecisionWriteRejected | WriteError> {
  const validation = validateDecisionWrite(decision, previous);
  if (validation) return Effect.fail(validation);
  return writeCoordinatedPayload(coordinator, hashPayload, {
    entityId: decisionEntityId(decision.decision_id),
    kind,
    payload: {
      decision,
      ...(request.taskWrites && request.taskWrites.length > 0 ? { taskWrites: request.taskWrites } : {}),
      ...(request.body !== undefined ? { body: request.body } : {}),
      writeMode: writeMode ?? {
        kind: "snapshot",
        expectedWatermark: previous?._coordinatorWatermark ?? null
      }
    },
    ...(request.opIdPrefix ? { opIdPrefix: request.opIdPrefix } : {})
  }).pipe(Effect.as({ decisionId: decision.decision_id, state: decision.state }));
}

type DecisionDocumentWriteMode =
  | { readonly kind: "snapshot"; readonly expectedWatermark?: string | null; readonly appendBody?: string }
  | { readonly kind: "append_relation"; readonly relation: EntityRelationRecord };

function validateDecisionWrite(decision: DecisionPackage, previous?: DecisionPackage): DecisionWriteRejected | null {
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

function assertIndependentJudgmentActor(options: DecisionWriteServiceOptions, decisionId: string): DecisionWriteRejected | null {
  const currentActor = options.attribution?.actor;
  if (!currentActor) return rejection(decisionId, "decision judgment requires request attribution");
  try {
    const events: ReadonlyArray<UnionAttributionEvent> = options.readUnionAttributionEvents?.()
      ?? options.readAttributionEvents?.()
      ?? (options.rootInput ? readUnionAttributionEvents(options.rootInput) : []);
    const propose = events.find((event) => event.schema === "attribution-event/v1"
      ? event.kind === "decision_propose" && (event.entityId === decisionId || event.entityId === `decision/${decisionId}`)
      : event.mutationSet.mutations.some((mutation) =>
          mutation.action.action === "decision_propose" && mutation.entity.canonicalRef === `decision/${decisionId}`));
    // 溯源仍然 fail-closed,对谁都一样:判定前必须能验到那条不可变的 propose 事件。
    // 下面豁免的只是「判定者与提议者不得同一」,不是「提议事件必须存在」。
    if (!propose) return rejection(decisionId, "decision judgment requires an immutable decision_propose attribution event");
    // 判定动作没有 executor = 一个人在直接操作 → 分离校验整条豁免:人可以批自己提的,
    // 也可以批别人提的(dec_01KXCHW9MFV8E3QGZJJW91YNDS)。分离不变量承重的目的是阻止
    // **agent** 给自己签字 —— 那是问责层的核心承诺 —— 不是阻止人给自己签字。单人
    // 操作者是绝大多数决策的唯一提议者兼唯一权威,一律分离等于把他锁在自己的台账外面。
    if (!currentActor.executor) return null;
    const proposeActor: ActorAxes = propose.schema === "attribution-event/v1"
      ? propose.actor
      : {
          principal: { kind: "person", personId: propose.actorAxesBinding.principalPersonId },
          executor: propose.actorAxesBinding.executorAgentId === null
            ? null
            : { kind: "agent", id: propose.actorAxesBinding.executorAgentId }
        };
    return sameActorAxes(proposeActor, currentActor)
      ? rejection(decisionId, "an agent may not judge the decision it proposed; a human must sign off")
      : null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return rejection(decisionId, `decision judgment could not verify decision_propose attribution: ${detail}`);
  }
}

function sameActorAxes(left: ActorAxes, right: ActorAxes): boolean {
  return left.principal.personId === right.principal.personId && left.executor?.id === right.executor?.id;
}

function contentPinActor(actor: ActorAxes): NonNullable<DecisionPackage["contentPins"]>[number]["arbiter"] {
  return actor.executor
    ? { kind: "agent", id: actor.executor.id }
    : { kind: "human", id: actor.principal.personId };
}

function rejection(decisionId: string, reason: string): DecisionWriteRejected {
  return { _tag: "DecisionWriteRejected", decisionId, reason };
}
