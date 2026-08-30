import { composeDurableActionEnvelope } from "../../application/src/durable-action-envelope.ts";
import {
  type AuthorizationContext,
  type AuthorizationDecision,
  type ReceiptJsonValue,
} from "../../kernel/src/index.ts";
import { authorizeAction } from "./authorization.ts";
import type { RepoCellBinding } from "./repo-cell-types.ts";

export function authorizeHostAction(input: {
  readonly kind: string;
  readonly binding: RepoCellBinding;
  readonly actionId: string;
  readonly evaluatedAtCut: string;
  readonly now?: string;
}): AuthorizationDecision {
  const assignment = input.binding.assignmentScope,
    assignmentSource =
      typeof input.binding.source === "object" && input.binding.source.kind === "assignment"
        ? input.binding.source
        : null,
    context: AuthorizationContext = {
      ...(input.binding.source === "local" && input.binding.authorizationBindingMode !== "declared"
        ? {
            defaultBinding: {
              principalPersonId: input.binding.actor.principal.personId,
              source: "local" as const,
            },
          }
        : {}),
      ...(input.binding.roleBindings === undefined ? {} : { roleBindings: input.binding.roleBindings }),
      roleBindingTargets: ["settings/repository"],
      ...(assignment
        ? {
            assignmentBinding: {
              repoId: assignment.repoId,
              nodeId: assignmentSource?.nodeId ?? "",
              assignmentId: assignmentSource?.assignmentId ?? "",
              scope: assignment.scope as unknown as Readonly<Record<string, ReceiptJsonValue>>,
              ...(input.binding.writerEpoch === undefined ? {} : { writerEpoch: input.binding.writerEpoch }),
            },
          }
        : {}),
      ...(input.now ? { evaluatedAt: input.now } : {}),
      writeSource: input.binding.source,
      target: {},
      evaluatedAtCut: input.evaluatedAtCut,
    },
    envelope = composeDurableActionEnvelope({
      actionId: input.actionId,
      kind: input.kind,
      target: "settings/repository",
      actor: input.binding.actor,
    });
  return authorizeAction(envelope, context);
}

export function requireAuthorizedHostAction(input: Parameters<typeof authorizeHostAction>[0]): AuthorizationDecision {
  const decision = authorizeHostAction(input);
  if (decision.outcome === "denied")
    throw Object.assign(
      new Error(decision.nextActions.join(" ") || `Policy ${decision.policyRef} denied ${input.kind}.`),
      { code: "authorization_denied", authorizationDecision: decision },
    );
  return decision;
}
