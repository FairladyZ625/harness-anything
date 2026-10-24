import { createHash } from "node:crypto";
import {
  getExecutableEntityAction,
  isTerminalStatus,
  parseEntityRef,
  type AuthorizationDecision,
  type CanonicalEventStore,
  type DomainStatus,
  type EventPublicationKillpoint,
  type TaskProjection,
} from "@harness-anything/kernel";
import { executeRelationAction, reject } from "./entity-action-relation.ts";
import { resolveWriteSessionIdentity } from "./session-identity/index.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

export interface TerminalAwaitsWriteContext {
  readonly rootDir?: string;
  readonly repositoryId?: string;
  readonly store: CanonicalEventStore;
  readonly projection: TaskProjection;
  readonly now: () => string;
  readonly killpoint?: (point: EventPublicationKillpoint) => void;
}

interface AwaitsRetirementInput {
  readonly binding: RepoCellBinding;
  readonly opId: string;
  readonly authorizationDecision: AuthorizationDecision | null;
  readonly context: TerminalAwaitsWriteContext;
}

/**
 * A terminal transition retires the awaits Relations its entity initiated: once a Task is done or
 * cancelled, or a Decision is rejected or superseded, nobody can answer for that entity anymore,
 * so its asks must stop surfacing as open waits. Each retirement runs through the one existing
 * relation-unrelate write path right after the main catalog write, in the same single-write-queue
 * turn; opIds derived from the parent operation keep a replay idempotent.
 */
export function retireTaskAwaitsAtTerminalStatus(
  input: { readonly taskId: string; readonly status: DomainStatus | undefined } & AwaitsRetirementInput,
): void {
  if (input.status === undefined || !isTerminalStatus(input.status)) return;
  retireAwaitsInitiatedBy(
    `task/${input.taskId}`,
    `Task ${input.taskId} is ${input.status}; its awaits Relations retire with the terminal transition.`,
    input,
  );
}

/** Only rejected and superseded retire their waits: those transitions are in this change's scope,
 * while other Decision states keep whatever asks their owners posted. */
export function retireDecisionAwaitsAfterWrite(
  input: { readonly action: RepoTaskAction } & AwaitsRetirementInput,
): void {
  const supersededTarget =
      input.action.kind === "relation-relate" && input.action.relationType === "supersedes"
        ? parseEntityRef(String(input.action.targetRef))
        : null,
    decisionId = supersededTarget?.kind === "decision" ? supersededTarget.id : input.action.decisionId;
  if (
    (!input.action.kind.startsWith("decision-") && decisionId === null) ||
    input.action.dryRun === true ||
    typeof decisionId !== "string" ||
    !input.binding.authorizationDecision
  )
    return;
  const decision = input.context.projection.readDecision(decisionId).decision;
  if (!decision) reject("content_not_ready", `Decision ${decisionId} is not materialized.`);
  if (decision.state !== "rejected" && decision.state !== "superseded") return;
  retireAwaitsInitiatedBy(
    `decision/${decisionId}`,
    `Decision ${decisionId} is ${decision.state}; its awaits Relations retire with the terminal transition.`,
    { ...input, authorizationDecision: input.binding.authorizationDecision },
  );
}

function retireAwaitsInitiatedBy(entityRef: string, reason: string, input: AwaitsRetirementInput): void {
  if (input.authorizationDecision === null) return;
  const contract = getExecutableEntityAction("relation-unrelate");
  if (!contract?.execution) throw new Error("Action relation-unrelate has no write compiler.");
  const rows = input.context.projection.readRelationQuery({
    source: entityRef,
    relationType: "awaits",
    state: "active",
  }).rows;
  for (const { relationId } of rows) {
    // The unrelate executor adjudicates expectedVersion against readRelationEdge, so the fence
    // number comes from the same read; an edge that is no longer active simply drops out.
    const current = input.context.projection.readRelationEdge(relationId);
    if (current?.state !== "active") continue;
    executeRelationAction({
      rootDir: input.context.rootDir ?? "",
      repositoryId: input.context.repositoryId ?? input.context.rootDir ?? "",
      contract: { ...contract, execution: contract.execution },
      action: {
        kind: "relation-unrelate",
        relationId,
        reason,
        expectedVersion: current.workspaceRevision ?? 0,
      } as RepoTaskAction,
      binding: input.binding,
      opId: `op_${createHash("sha256").update(`${input.opId}:terminal-awaits:${relationId}`).digest("hex")}`,
      occurredAt: input.context.now(),
      authorizationDecision: input.authorizationDecision,
      store: input.context.store,
      projection: input.context.projection,
      sessionIdentity: (binding) => resolveWriteSessionIdentity(binding, input.context.projection),
      ...(input.context.killpoint ? { killpoint: input.context.killpoint } : {}),
    });
  }
}
