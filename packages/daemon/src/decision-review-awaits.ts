import { createHash } from "node:crypto";
import {
  decisionAcceptReviewReadiness,
  deriveRelationId,
  getExecutableEntityAction,
  type AuthorizationDecision,
  type CanonicalEventStore,
  type EventPublicationKillpoint,
  type SessionIdentity,
  type TaskProjection,
  type RepositorySettingsV1,
} from "@harness-anything/kernel";
import { decisionReviewAwaitRationale } from "./decision-review-read.ts";
import { executeRelationAction, reject } from "./entity-action-relation.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

interface DecisionReviewAwaitInput {
  readonly decisionId: string;
  readonly binding: RepoCellBinding;
  readonly opId: string;
  readonly authorizationDecision: AuthorizationDecision;
  readonly rootDir: string;
  readonly repositoryId: string;
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly now: () => string;
  readonly sessionIdentity: (binding: RepoCellBinding) => SessionIdentity;
  readonly killpoint?: (point: EventPublicationKillpoint) => void;
  readonly readSettings: () => RepositorySettingsV1;
}

interface DecisionWriteContext {
  readonly rootDir?: string;
  readonly repositoryId?: string;
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly now: () => string;
  readonly sessionIdentity: (binding: RepoCellBinding) => SessionIdentity;
  readonly killpoint?: (point: EventPublicationKillpoint) => void;
  readonly readSettings: () => RepositorySettingsV1;
}

/**
 * Runs after a catalog write succeeded. A proposal has no reviews yet and a dry run publishes nothing,
 * so only a published write to an existing Decision can change whether its owner is awaited; the
 * main write has already authorized this binding.
 */
export function reconcileDecisionReviewAwaitAfterWrite(
  action: RepoTaskAction,
  binding: RepoCellBinding,
  opId: string,
  context: DecisionWriteContext,
): void {
  if (
    !action.kind.startsWith("decision-") ||
    action.dryRun === true ||
    typeof action.decisionId !== "string" ||
    !binding.authorizationDecision
  )
    return;
  reconcileDecisionReviewAwait({
    decisionId: action.decisionId,
    binding,
    opId,
    authorizationDecision: binding.authorizationDecision,
    rootDir: context.rootDir ?? "",
    repositoryId: context.repositoryId ?? context.rootDir ?? "",
    store: context.store,
    projection: context.projection,
    now: context.now,
    sessionIdentity: context.sessionIdentity,
    readSettings: context.readSettings,
    ...(context.killpoint ? { killpoint: context.killpoint } : {}),
  });
}

function reconcileDecisionReviewAwait(input: DecisionReviewAwaitInput): void {
  const decision = input.projection.readDecision(input.decisionId).decision;
  if (!decision) reject("content_not_ready", `Decision ${input.decisionId} is not materialized.`);
  // Only a changes_requested review raises the notification and review history is append-only, so a
  // Decision that never had one has no edge to reconcile.
  if (!decision.reviews.some(({ verdict }) => verdict === "changes_requested")) return;
  const identity = {
      source: `decision/${input.decisionId}`,
      target: `person/${decision.proposer.principal.personId}`,
      type: "awaits" as const,
      direction: "directed" as const,
    },
    current = input.projection.readRelationEdge(deriveRelationId(identity)),
    rationale = decisionReviewAwaitRationale(input.decisionId),
    shouldAwait =
      decision.state === "proposed" &&
      decision.body !== null &&
      decisionAcceptReviewReadiness(decision, decision.body.body, input.readSettings().decisionReviewRequirement)
        .blocker?.code === "changes_requested";
  if (shouldAwait) {
    if (current?.state === "active") return;
    runRelation(input, "relation-relate", {
      kind: "relation-relate",
      sourceRef: identity.source,
      targetRef: identity.target,
      relationType: identity.type,
      direction: identity.direction,
      rationale,
      expectedVersion: current?.workspaceRevision ?? 0,
    });
    return;
  }
  // An ask a person wrote on the same edge is theirs to answer; only the review notification retires here.
  if (current?.state !== "active" || current.rationale !== rationale) return;
  runRelation(input, "relation-unrelate", {
    kind: "relation-unrelate",
    relationId: current.relationId,
    reason: "The Decision has no review changes awaiting its owner on the current content.",
    expectedVersion: current.workspaceRevision,
  });
}

function runRelation(
  input: DecisionReviewAwaitInput,
  ingress: "relation-relate" | "relation-unrelate",
  action: Parameters<typeof executeRelationAction>[0]["action"],
): void {
  const contract = getExecutableEntityAction(ingress);
  if (!contract?.execution) throw new Error(`Action ${ingress} has no write compiler.`);
  executeRelationAction({
    rootDir: input.rootDir,
    repositoryId: input.repositoryId,
    contract: { ...contract, execution: contract.execution },
    action,
    binding: input.binding,
    opId: `op_${createHash("sha256").update(`${input.opId}:decision-review-await`).digest("hex")}`,
    occurredAt: input.now(),
    authorizationDecision: input.authorizationDecision,
    store: input.store,
    projection: input.projection,
    sessionIdentity: input.sessionIdentity,
    ...(input.killpoint ? { killpoint: input.killpoint } : {}),
  });
}
