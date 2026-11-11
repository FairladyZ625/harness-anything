import { createFactEvent } from "./fact-event.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
export {
  attributeEntityActionCriterion,
  entityActionCriterionFailure,
  type EntityActionCriterionFailure,
} from "./entity-action-criterion.ts";
import type { SessionIdentity } from "./agent-runtime.ts";
import { sessionProvenance } from "./agent-runtime.ts";
import type { ActorIdentity } from "./actor-identity.ts";
import {
  createDecisionEvent,
  decisionTransitionDefinitions,
  type DecisionAmendableSnapshot,
  type DecisionAmendmentOwnerConsentV1,
  type DecisionEventDraftV1,
  type DecisionReviewFindingV1,
  type DecisionReviewResponseV1,
} from "./decision-event.ts";
import { reviewFindingCategories, reviewFindingLabels } from "./review.ts";
import { proposalIssues } from "./decision-event-payload-validation.ts";
import { deriveRelationId } from "./entity-relation.ts";
import type { CanonicalRelationDirection } from "./relation-direction.ts";
import {
  compileRelationCreatedEvent,
  compileRelationReconfirmedEvent,
  compileRelationRetiredEvent,
  type RelationEventV1,
} from "./relation-event.ts";
import type { EntityVersion } from "./entity-freshness.ts";
import {
  factConfidenceLevels,
  factMemoryClasses,
  factMemoryTags,
  validDomainType,
  type FactEventDraftV1,
  type FactEventV1,
} from "./fact-event.ts";
import { timestamp } from "./timestamp.ts";
import { assertTransitionDocumentReady } from "./transition-document-readiness.ts";
import type { WriteSource } from "./write-chain.contract.ts";
import type { ScheduleActionDraft } from "./schedule-action-contract.ts";
import type { AgentActionDraft } from "./agent-action-contract.ts";
import type { RuntimeSessionActionDraft } from "./runtime-session-action-contract.ts";
import type { SettingsActionDraft } from "./settings-action-contract.ts";
import type { PersonActionDraft } from "./person-action-contract.ts";
import type { SquadActionDraft } from "./squad-action-contract.ts";

export interface EntityActionExecutionContract {
  readonly ingress: string;
  readonly compile: EntityActionCompileHook | null;
  readonly read: boolean;
  readonly implementation:
    | "compiled-event"
    | "declared-only"
    | "catalog-runtime"
    | "task-lifecycle"
    | "task-completion";
  readonly topology?: "center-forward-write" | "ledger-write" | "local-arbiter";
  readonly remoteEdgeAdmission?: "via-center-forward" | "rejected";
  readonly localOnlyFields?: readonly string[];
  readonly targetIdField?: string;
  readonly lifecycle?: {
    readonly transitionId: string;
    readonly commandType: string;
    readonly targetIdField: string;
    readonly coordination: "reserve" | "execute";
    readonly eventType: string;
    readonly proof: readonly string[];
    /**
     * The criterion a rejected invocation is attributed to: the guard that decides whether this
     * command may be built and applied at all. Declared here, not derived from the action id by
     * naming convention: when the two disagreed, attribution threw a second error that replaced the
     * rejection's own reason. Null when no single guard owns the refusal — `create` attributes its
     * compile and graph refusals in `createTask`, which never reaches the lifecycle runtime.
     */
    readonly validatorCriterionRef: string | null;
  };
}

export interface EntityActionCompileInput {
  readonly action: Readonly<Record<string, unknown>>;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly session: SessionIdentity;
  readonly opId: string;
  readonly occurredAt: string;
  readonly workspaceRevision: number;
  readonly currentEntity?: unknown;
  readonly entityRevision?: number;
  readonly currentDocumentBlobSha256?: string | null;
  readonly currentDocumentBody?: string;
  readonly priorTargetVersion?: EntityVersion | null;
  readonly currentTargetVersion?: EntityVersion | null;
  /** The composed direction registry (kernel rows plus the compiled vertical rows) admitting the write. */
  readonly relationDirections?: readonly CanonicalRelationDirection[];
  readonly coverage?: {
    readonly decisionId: string;
    readonly taskId: string;
    readonly basisRevision: number;
    readonly rows: readonly {
      readonly claimRef: string;
      readonly status: string;
      readonly basisRevision: number;
    }[];
  };
}

export type EntityActionDraft =
  | AgentActionDraft
  | SquadActionDraft
  | RuntimeSessionActionDraft
  | { readonly kind: "decision"; readonly event: DecisionEventDraftV1 }
  | { readonly kind: "fact"; readonly event: FactEventDraftV1 }
  | { readonly kind: "fact-archive"; readonly event: FactEventDraftV1 }
  | { readonly kind: "fact-unarchive"; readonly event: FactEventDraftV1 }
  | { readonly kind: "relation"; readonly event: RelationEventV1 }
  | { readonly kind: "schedule"; readonly result: ScheduleActionDraft }
  | { readonly kind: "settings"; readonly result: SettingsActionDraft }
  | { readonly kind: "person"; readonly result: PersonActionDraft };
export type EntityActionCompileHook = (input: EntityActionCompileInput) => EntityActionDraft;

export function compileFactRecordAction(input: EntityActionCompileInput): EntityActionDraft {
  const action = input.action,
    confidence = factClassification(input, "--confidence", action.confidence, factConfidenceLevels),
    domainTypes = stringList(action.domainTypes),
    memoryClass = factClassification(input, "--memory-class", action.memoryClass, factMemoryClasses),
    memoryTags = stringList(action.memoryTags).map((tag) =>
      factClassification(input, "--memory-tag", tag, factMemoryTags),
    ),
    observedAt = typeof action.observedAt === "string" ? action.observedAt : input.occurredAt,
    observedCommit = typeof action.observedCommit === "string" ? action.observedCommit : undefined;
  for (const domainType of domainTypes)
    if (!validDomainType(domainType))
      invalid(
        input,
        `--type ${JSON.stringify(domainType)} is invalid; expected 1-64 characters with no leading/trailing whitespace or control characters. Run ha fact type list for registered values or ha fact type register <type> --source <source> to register one.`,
      );
  if (!timestamp(input.occurredAt) || !timestamp(observedAt))
    invalid(input, "Fact timestamps must be ISO-8601 UTC values ending in Z.");
  if (observedCommit !== undefined && !/^[0-9a-f]{40}$/u.test(observedCommit))
    invalid(input, "Fact observedCommit must be a 40-character lowercase hex commit id.");
  if (action.supersedes !== undefined) {
    if (
      !plainRecordValue(action.supersedes) ||
      !/^fact\/F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(String(action.supersedes.factRef))
    )
      invalid(
        input,
        'Fact --supersedes requires a canonical ref. Use --supersedes fact/F-12345678 --rationale "Replaces the earlier observation." (replace the example with the target Fact ref).',
      );
    if (
      typeof action.supersedes.rationale !== "string" ||
      [...action.supersedes.rationale].length < 1 ||
      [...action.supersedes.rationale].length > 199
    )
      invalid(
        input,
        'Fact --rationale must contain 1-199 characters. Use --rationale "Replaces the earlier observation.".',
      );
  }
  return {
    kind: "fact",
    event: createFactEvent({
      eventId: eventId(input.opId),
      workspaceRevision: input.workspaceRevision,
      opId: input.opId,
      ...(typeof action.taskId === "string" && action.taskId.trim() ? { taskId: action.taskId.trim() } : {}),
      factId:
        typeof action.factId === "string"
          ? requiredText(input, action.factId, "factId")
          : `F-${digest(input.opId).slice(0, 8).toUpperCase()}`,
      actor: input.actor,
      source: input.source,
      occurredAt: input.occurredAt,
      payload: {
        statement: requiredText(input, action.statement, "statement"),
        evidenceSource: requiredText(input, action.evidenceSource, "evidenceSource"),
        observedAt,
        ...(observedCommit !== undefined ? { observedCommit } : {}),
        confidence,
        ...(domainTypes.length ? { domainTypes } : {}),
        ...(typeof action.registersDomainType === "string" ? { registersDomainType: action.registersDomainType } : {}),
        memoryClass,
        memoryTags: memoryTags as FactEventV1["payload"]["memoryTags"],
        provenance: [sessionProvenance(input.session, input.occurredAt)],
        ...(plainRecordValue(action.supersedes)
          ? {
              supersedes: action.supersedes as {
                readonly factRef: string;
                readonly rationale: string;
              },
            }
          : {}),
      },
    }),
  };
}

export function compileFactReclassifyAction(input: EntityActionCompileInput): EntityActionDraft {
  const recorded = compileFactRecordAction(input);
  if (recorded.kind !== "fact") throw new Error("fact reclassification compiler produced a non-Fact draft");
  return {
    kind: "fact",
    event: createFactEvent(
      {
        ...recorded.event,
        payload: {
          ...recorded.event.payload,
          reclassificationRationale: requiredText(input, input.action.rationale, "rationale"),
        },
      },
      "fact_reclassified",
    ),
  };
}

/** Archive/unarchive drafts reuse the Fact observation snapshot the daemon preloaded from the
 * projection row (same fields `reclassify` copies); the archive reason is the only authored input. */
function compileFactArchiveDraft(
  input: EntityActionCompileInput,
  type: "fact_archived" | "fact_unarchived",
): FactEventDraftV1 {
  const recorded = compileFactRecordAction(input);
  if (recorded.kind !== "fact") throw new Error("fact archive compiler produced a non-Fact draft");
  return {
    ...recorded.event,
    type,
    payload: {
      ...recorded.event.payload,
      archiveReason: short(input, input.action.reason, "reason"),
    },
  };
}
export function compileFactArchiveAction(input: EntityActionCompileInput): EntityActionDraft {
  return { kind: "fact-archive", event: compileFactArchiveDraft(input, "fact_archived") };
}
export function compileFactUnarchiveAction(input: EntityActionCompileInput): EntityActionDraft {
  return { kind: "fact-unarchive", event: compileFactArchiveDraft(input, "fact_unarchived") };
}

export type DecisionActionCompilerId =
  | "accept"
  | "amend"
  | "declare-claim"
  | "defer"
  | "fulfill-claim"
  | "propose"
  | "relate"
  | "reject"
  | "repin"
  | "review"
  | "respond-review"
  | "override-review"
  | "replace-relation"
  | "retire"
  | "retire-relation"
  | "transition";

export function decisionActionCompiler(id: DecisionActionCompilerId): EntityActionCompileHook {
  return (input) => ({ kind: "decision", event: decisionEvent(id, input) });
}

export function compileDecisionReckonAction(input: EntityActionCompileInput): EntityActionDraft {
  const coverage = input.coverage;
  if (!coverage) invalid(input, "Decision coverage is required for reckon.");
  const report = coverage.rows.map((row) => `${row.claimRef}=${row.status}`).join(", ") || "no load-bearing claims";
  return {
    kind: "fact",
    event: createFactEvent({
      eventId: eventId(input.opId),
      workspaceRevision: input.workspaceRevision,
      opId: input.opId,
      taskId: coverage.taskId,
      factId: `F-${digest(input.opId).slice(0, 8).toUpperCase()}`,
      actor: input.actor,
      source: input.source,
      occurredAt: input.occurredAt,
      payload: {
        statement: `Decision ${coverage.decisionId} coverage at basisRevision ${coverage.basisRevision}: ${report}.`,
        evidenceSource: `decision/${coverage.decisionId}@${coverage.basisRevision}`,
        observedAt: input.occurredAt,
        confidence: "high",
        memoryClass: "semantic",
        memoryTags: ["abstract_rule"],
        provenance: [sessionProvenance(input.session, input.occurredAt)],
      },
    }),
  };
}

export function relationActionCompiler(id: "relate" | "unrelate" | "reconfirm"): EntityActionCompileHook {
  return (input) => {
    if (id === "unrelate")
      return {
        kind: "relation",
        event: compileRelationRetiredEvent({
          relationId: requiredText(input, input.action.relationId, "relationId"),
          reason: requiredText(input, input.action.reason, "reason"),
          actor: input.actor,
          source: input.source,
          opId: input.opId,
          occurredAt: input.occurredAt,
          workspaceRevision: input.workspaceRevision,
        }),
      };
    if (id === "reconfirm") {
      const targetObservedVersion = input.currentTargetVersion;
      if (targetObservedVersion === null || targetObservedVersion === undefined)
        invalid(input, "Relation target must have a current version before it can be reconfirmed.");
      return {
        kind: "relation",
        event: compileRelationReconfirmedEvent({
          relationId: requiredText(input, input.action.relationId, "relationId"),
          priorTargetVersion: input.priorTargetVersion ?? null,
          targetObservedVersion,
          rationale: requiredText(input, input.action.rationale, "rationale"),
          actor: input.actor,
          source: input.source,
          opId: input.opId,
          occurredAt: input.occurredAt,
          workspaceRevision: input.workspaceRevision,
        }),
      };
    }
    const identity = {
      source: requiredText(input, input.action.sourceRef, "sourceRef"),
      target: requiredText(input, input.action.targetRef, "targetRef"),
      type: requiredText(input, input.action.relationType, "relationType") as never,
      direction: (typeof input.action.direction === "string" ? input.action.direction : "directed") as "directed",
    };
    return {
      kind: "relation",
      event: compileRelationCreatedEvent({
        record: {
          relation_id: deriveRelationId(identity),
          ...identity,
          origin: (typeof input.action.origin === "string" ? input.action.origin : "declared") as "declared",
          state: "active",
          rationale: requiredText(input, input.action.rationale, "rationale"),
          targetObservedVersion: input.currentTargetVersion ?? null,
        },
        actor: input.actor,
        source: input.source,
        opId: input.opId,
        occurredAt: input.occurredAt,
        workspaceRevision: input.workspaceRevision,
        ...(input.relationDirections ? { directions: input.relationDirections } : {}),
      }),
    };
  };
}

function decisionEvent(id: DecisionActionCompilerId, input: EntityActionCompileInput): DecisionEventDraftV1 {
  const action = input.action,
    decisionId =
      id === "propose"
        ? `dec_${digest(input.opId).slice(0, 26).toUpperCase()}`
        : requiredText(input, action.decisionId, "decisionId"),
    base = {
      eventId: eventId(input.opId),
      workspaceRevision: input.workspaceRevision,
      opId: input.opId,
      decisionId,
      actor: input.actor,
      source: input.source,
      occurredAt: input.occurredAt,
    };
  if (id === "propose") {
    const proposal = {
        title: action.title,
        question: action.question,
        riskTier: action.riskTier,
        urgency: action.urgency,
        vertical: action.vertical,
        preset: action.preset,
        appliesTo: action.appliesTo,
        decisionClass: action.decisionClass,
        chosen: action.chosen,
        rejected: action.rejected,
        body:
          typeof action.body === "string"
            ? action.body
            : decisionBodyTemplate(typeof action.title === "string" ? action.title : ""),
        claims: action.claims,
        fulfillments: action.fulfillments,
        relations: [],
        provenance: [sessionProvenance(input.session, input.occurredAt)],
      },
      issues = proposalIssues(proposal, [], decisionId);
    if (issues.length > 0) invalid(input, issues.join("; "));
    assertTransitionDocumentReady("decision.body", proposal.body);
    return createDecisionEvent(base, "decision_proposed", proposal as never);
  }
  if (id === "transition") return transitionEvent(input, base);
  if (id === "accept")
    return createDecisionEvent(base, "decision_accepted", {
      rationale: short(input, action.rationale, "rationale"),
      judgmentOnlyRationale:
        typeof action.judgmentOnlyRationale === "string"
          ? short(input, action.judgmentOnlyRationale, "judgmentOnlyRationale")
          : null,
      fulfillments: [],
      standingPolicy: false,
      ...(typeof action.reviewId === "string" ? { reviewId: action.reviewId } : {}),
      ...(typeof action.expectedDigest === "string"
        ? { expectedDigest: action.expectedDigest as `sha256:${string}` }
        : {}),
      ...(typeof action.policyRevision === "number" ? { policyRevision: action.policyRevision } : {}),
    });
  if (id === "reject")
    return createDecisionEvent(base, "decision_rejected", { reason: short(input, action.reason, "reason") });
  if (id === "defer")
    return createDecisionEvent(base, "decision_deferred", { reason: short(input, action.reason, "reason") });
  if (id === "retire")
    return createDecisionEvent(base, "decision_retired", { reason: short(input, action.reason, "reason") });
  if (id === "amend") {
    if (typeof action.body === "string") assertTransitionDocumentReady("decision.body", action.body);
    return createDecisionEvent(base, "decision_amended", {
      previous: object(input, action.previous, "previous") as unknown as DecisionAmendableSnapshot,
      next: object(input, action.next, "next") as unknown as DecisionAmendableSnapshot,
      fields: stringList(action.fields),
      body: typeof action.body === "string" ? action.body : null,
      reason: short(input, action.reason, "reason"),
      ...(action.ownerConsent === undefined
        ? {}
        : {
            ownerConsent: object(
              input,
              action.ownerConsent,
              "ownerConsent",
            ) as unknown as DecisionAmendmentOwnerConsentV1,
          }),
    });
  }
  if (id === "repin")
    return createDecisionEvent(base, "decision_repinned", {
      migrationEvidence: requiredText(input, action.migrationEvidence, "migrationEvidence"),
    });
  if (id === "review")
    return createDecisionEvent(base, "decision_review_recorded", {
      reviewId: requiredText(input, action.reviewId, "reviewId"),
      reviewContentDigest: requiredText(input, action.reviewContentDigest, "reviewContentDigest") as `sha256:${string}`,
      verdict: choice(input, action.verdict, ["approved", "changes_requested"], "verdict"),
      reason: requiredText(input, action.reason, "reason"),
      findings: reviewFindings(input, action.findings),
      evidenceChecked: stringList(action.evidenceChecked),
      reportRef: typeof action.reportRef === "string" ? action.reportRef : null,
    });
  if (id === "respond-review")
    return createDecisionEvent(base, "decision_review_responded", {
      responses: reviewResponses(input, action.responses),
    });
  if (id === "override-review")
    return createDecisionEvent(base, "decision_review_overridden", {
      reviewContentDigest: requiredText(input, action.reviewContentDigest, "reviewContentDigest") as `sha256:${string}`,
      reviewIds: stringList(action.reviewIds),
      reason: requiredText(input, action.reason, "reason"),
    });
  if (id === "declare-claim")
    return createDecisionEvent(base, "decision_claim_declared", {
      claimId: requiredText(input, action.claimId, "claimId"),
      text: requiredText(input, action.text, "text"),
      loadBearing: action.loadBearing !== false,
    });
  if (id === "fulfill-claim")
    return createDecisionEvent(base, "decision_claim_fulfillment_declared", {
      claimId: requiredText(input, action.claimId, "claimId"),
      mode: choice(input, action.mode, ["evidenced", "delivered", "standing_policy"], "mode"),
    });
  if (id === "relate") return relationEvent(input, base);
  if (id === "retire-relation")
    return createDecisionEvent(base, "decision_relation_retired", {
      relationId: requiredText(input, action.relationId, "relationId"),
      reason: requiredText(input, action.reason, "reason"),
    });
  return replacementEvent(input, base);
}

function decisionBodyTemplate(title: string): string {
  return [
    `\n# ${title}`,
    "",
    "## 背景",
    "",
    "说明需要裁定的问题与已知事实。",
    "",
    "## 权衡",
    "",
    "说明所选方案、被拒方案与取舍理由。",
    "",
    "## 结论",
    "",
    "说明最终裁定及其适用范围。",
    "",
  ].join("\n");
}

function transitionEvent(
  input: EntityActionCompileInput,
  base: Omit<DecisionEventDraftV1, "schema" | "type" | "payload">,
): DecisionEventDraftV1 {
  // Adjudication targets (proposed → in_effect/rejected/deferred) compile only through the
  // accept/reject/defer action family; transition is the in_effect → superseded/outcome_retired
  // bookkeeping family, so its targetState choice is the non-proposed half of the definitions.
  const action = input.action,
    state = choice(
      input,
      action.targetState,
      decisionTransitionDefinitions
        .filter(({ sourceState }) => sourceState !== "proposed")
        .map(({ targetState }) => targetState),
      "targetState",
    ),
    reason =
      typeof action.reason === "string"
        ? short(input, action.reason, "reason")
        : `Transitioned to ${state} via the canonical Decision lifecycle command.`;
  return state === "superseded"
    ? createDecisionEvent(base, "decision_superseded", { reason })
    : createDecisionEvent(base, "decision_retired", { reason });
}

function relationEvent(
  input: EntityActionCompileInput,
  base: Omit<DecisionEventDraftV1, "schema" | "type" | "payload">,
): DecisionEventDraftV1 {
  const action = input.action,
    identity = {
      source: `decision/${base.decisionId}/${requiredText(input, action.anchor, "anchor")}`,
      target: requiredText(input, action.target, "target"),
      type: requiredText(input, action.relationType, "relationType") as never,
      direction: "directed" as const,
    };
  return createDecisionEvent(base, "decision_related", {
    relation: {
      relation_id: deriveRelationId(identity),
      ...identity,
      strength: "strong",
      origin: "declared",
      rationale: requiredText(input, action.rationale, "rationale"),
      state: "active",
    },
  });
}

function replacementEvent(
  input: EntityActionCompileInput,
  base: Omit<DecisionEventDraftV1, "schema" | "type" | "payload">,
): DecisionEventDraftV1 {
  const action = input.action,
    identity = {
      source: `decision/${base.decisionId}/${requiredText(input, action.anchor, "anchor")}`,
      target: requiredText(input, action.target, "target"),
      type: requiredText(input, action.relationType, "relationType") as never,
      direction: "directed" as const,
    },
    replacement = {
      relation_id: deriveRelationId(identity),
      ...identity,
      strength: "strong" as const,
      origin: "declared" as const,
      rationale: short(input, action.rationale, "rationale"),
      state: "active" as const,
    };
  return createDecisionEvent(base, "decision_relation_replaced", {
    relationId: requiredText(input, action.relationId, "relationId"),
    reason: `Replaced atomically by ${replacement.relation_id}.`,
    replacement,
    body: typeof action.body === "string" ? action.body : null,
  });
}

function requiredText(input: EntityActionCompileInput, value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value;
  invalid(input, `${field} is required.`);
}
function short(input: EntityActionCompileInput, value: unknown, field: string): string {
  const text = requiredText(input, value, field);
  if ([...text].length <= 199) return text;
  invalid(input, `${field} must contain at most 199 characters.`);
}
function object(input: EntityActionCompileInput, value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (plainRecordValue(value)) return value;
  invalid(input, `${field} must be an object.`);
}
function factClassification<T extends string>(
  input: EntityActionCompileInput,
  flag: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value === "string" && allowed.includes(value as T)) return value as T;
  invalid(input, `${flag} ${JSON.stringify(value)} is invalid; expected one of: ${allowed.join(", ")}.`);
}
function choice<T extends string>(
  input: EntityActionCompileInput,
  value: unknown,
  choices: readonly T[],
  field: string,
): T {
  if (typeof value === "string" && choices.includes(value as T)) return value as T;
  invalid(input, `${field} is invalid; expected one of: ${choices.join(", ")}.`);
}
const reviewResponseFields = ["reviewId", "findingId", "disposition", "rationale", "amendmentRef"],
  reviewFindingFields = ["findingId", "text", "anchor", "category", "label", "evidenceDigest", "priorFindingRefs"];

/**
 * Review packets reach the kernel as raw JSON items. Compile runs before the finding-existence
 * judgment (assertDecisionReviewMutation), so checking each item's own fields here makes a
 * malformed response name its field instead of surfacing as a missing review finding; the same
 * checks previously fired only at event serialization with a packet-level message.
 */
function reviewResponses(
  input: EntityActionCompileInput,
  value: unknown,
): readonly Omit<DecisionReviewResponseV1, "actor" | "respondedAt">[] {
  if (!Array.isArray(value) || value.length === 0) invalid(input, "responses must be a non-empty array.");
  return value.map((response, index) => {
    if (!plainRecordValue(response)) invalid(input, `responses[${index}] must be an object.`);
    const label = `responses[${index}]`,
      record = {
        reviewId: requiredText(input, response.reviewId, `${label}.reviewId`),
        findingId: requiredText(input, response.findingId, `${label}.findingId`),
        disposition: choice(input, response.disposition, ["adopt", "rebut"] as const, `${label}.disposition`),
        rationale: requiredText(input, response.rationale, `${label}.rationale`),
        amendmentRef:
          response.amendmentRef === null || response.amendmentRef === undefined
            ? null
            : requiredText(input, response.amendmentRef, `${label}.amendmentRef`),
      },
      unknown = Object.keys(response).filter((field) => !reviewResponseFields.includes(field));
    if (unknown.length > 0)
      invalid(
        input,
        `${label} does not accept ${unknown.join(", ")}; allowed fields are ${reviewResponseFields.join(", ")}.`,
      );
    return record;
  });
}
function reviewFindings(input: EntityActionCompileInput, value: unknown): readonly DecisionReviewFindingV1[] {
  if (!Array.isArray(value)) invalid(input, "findings must be an array.");
  return value.map((finding, index) => {
    if (!plainRecordValue(finding)) invalid(input, `findings[${index}] must be an object.`);
    const label = `findings[${index}]`,
      category = optionalFindingCategory(input, finding.category, `${label}.category`),
      findingLabel = optionalFindingLabel(input, finding.label, `${label}.label`),
      evidenceDigest = optionalFindingEvidence(input, finding.evidenceDigest, `${label}.evidenceDigest`),
      priorFindingRefs = optionalFindingRefs(input, finding.priorFindingRefs, `${label}.priorFindingRefs`),
      record = {
        findingId: requiredText(input, finding.findingId, `${label}.findingId`),
        text: requiredText(input, finding.text, `${label}.text`),
        ...(finding.anchor === undefined ? {} : { anchor: requiredText(input, finding.anchor, `${label}.anchor`) }),
        ...(category === undefined ? {} : { category }),
        ...(findingLabel === undefined ? {} : { label: findingLabel }),
        ...(evidenceDigest === undefined ? {} : { evidenceDigest }),
        ...(priorFindingRefs === undefined ? {} : { priorFindingRefs }),
      },
      unknown = Object.keys(finding).filter((field) => !reviewFindingFields.includes(field));
    if (unknown.length > 0)
      invalid(
        input,
        `${label} does not accept ${unknown.join(", ")}; allowed fields are ${reviewFindingFields.join(", ")}.`,
      );
    return record;
  });
}
function optionalFindingCategory(
  input: EntityActionCompileInput,
  value: unknown,
  field: string,
): DecisionReviewFindingV1["category"] {
  if (value === undefined) return undefined;
  if (!reviewFindingCategories.includes(value as (typeof reviewFindingCategories)[number]))
    invalid(input, `${field} must be one of ${reviewFindingCategories.join(", ")}.`);
  return value as DecisionReviewFindingV1["category"];
}
function optionalFindingLabel(
  input: EntityActionCompileInput,
  value: unknown,
  field: string,
): DecisionReviewFindingV1["label"] {
  if (value === undefined) return undefined;
  if (!reviewFindingLabels.includes(value as (typeof reviewFindingLabels)[number]))
    invalid(input, `${field} must be one of ${reviewFindingLabels.join(", ")}.`);
  return value as DecisionReviewFindingV1["label"];
}
function optionalFindingEvidence(
  input: EntityActionCompileInput,
  value: unknown,
  field: string,
): `sha256:${string}` | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value))
    invalid(input, `${field} must be a sha256 digest.`);
  return value as `sha256:${string}`;
}
function optionalFindingRefs(
  input: EntityActionCompileInput,
  value: unknown,
  field: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || !entry.trim()))
    invalid(input, `${field} must be a non-empty array of finding references.`);
  return value as readonly string[];
}
function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}
function plainRecordValue(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalid(input: EntityActionCompileInput, message: string): never {
  throw Object.assign(new Error(message), { code: "invalid_command" });
}
function digest(value: string): string {
  return sha256Text(value);
}
function eventId(opId: string): string {
  return `event-${digest(opId)}`;
}
