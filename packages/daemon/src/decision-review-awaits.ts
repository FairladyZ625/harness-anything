import { createHash } from "node:crypto";
import {
  deriveRelationId,
  getExecutableEntityAction,
  type AuthorizationDecision,
  type CanonicalEventStore,
  type EventPublicationKillpoint,
  type SessionIdentity,
  type TaskProjection,
} from "@harness-anything/kernel";
import { executeRelationAction, reject } from "./entity-action-relation.ts";
import type { RepoCellBinding } from "./repo-cell-types.ts";

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
}

export function ensureDecisionReviewAwait(input: DecisionReviewAwaitInput): void {
  const { identity, current } = decisionReviewAwait(input);
  if (current?.state === "active") return;
  runRelation(input, "relation-relate", {
    kind: "relation-relate",
    sourceRef: identity.source,
    targetRef: identity.target,
    relationType: identity.type,
    direction: identity.direction,
    rationale: `consent: Decision ${input.decisionId} has review changes to resolve.`,
    expectedVersion: current?.workspaceRevision ?? 0,
  });
}

export function retireDecisionReviewAwait(input: DecisionReviewAwaitInput): void {
  const { current } = decisionReviewAwait(input);
  if (!current || current.state !== "active") return;
  runRelation(input, "relation-unrelate", {
    kind: "relation-unrelate",
    relationId: current.relationId,
    reason: "The proposal owner disposed the Decision review changes.",
    expectedVersion: current.workspaceRevision,
  });
}

function decisionReviewAwait(input: DecisionReviewAwaitInput) {
  const decision = input.projection.readDecision(input.decisionId).decision,
    personId = decision?.proposer.principal.personId;
  if (!personId) reject("content_not_ready", `Decision ${input.decisionId} has no proposal owner.`);
  const identity = {
    source: `decision/${input.decisionId}`,
    target: `person/${personId}`,
    type: "awaits" as const,
    direction: "directed" as const,
  };
  return { identity, current: input.projection.readRelationEdge(deriveRelationId(identity)) };
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
