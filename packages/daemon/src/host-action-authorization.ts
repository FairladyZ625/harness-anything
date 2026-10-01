import { composeDurableActionEnvelope } from "@harness-anything/application/internal/durable-action-envelope";
import {
  DEFAULT_POLICY,
  type AuthorizationContext,
  type AuthorizationDecision,
  type ReceiptJsonValue,
} from "@harness-anything/kernel";
import { authorizeAction } from "./authorization.ts";
import { localDefaultBinding, localSystemActionBinding } from "./daemon-host-binding.ts";
import { KeycloakPolicyAdapter } from "./keycloak-policy-adapter.ts";
import { keycloakDecision } from "./repo-cell-authorization.ts";
import type { RepoCellBinding } from "./repo-cell-types.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";

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
  return authorizeAction({ ...envelope, authorizationRef: `${DEFAULT_POLICY.id}@${DEFAULT_POLICY.version}` }, context);
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

/** A signed-in person's host-level action answers to that person's fleet grant, never to a repository's. */
export async function evaluateFleetAction(input: {
  readonly kind: string;
  readonly binding: RepoCellBinding;
  readonly actionId: string;
  readonly evaluatedAtCut: string;
  readonly fetchPort?: typeof fetch;
}): Promise<AuthorizationDecision> {
  const envelope = composeDurableActionEnvelope({
      actionId: input.actionId,
      kind: input.kind,
      target: "settings/repository",
      actor: input.binding.actor,
    }),
    credential = input.binding.keycloakAuthorization;
  if (!credential) return keycloakDecision(envelope, input.evaluatedAtCut, "denied", "authentication_required");
  const result = await new KeycloakPolicyAdapter(
    { url: credential.url, realm: credential.realm, resourceServerClientId: credential.clientId },
    input.fetchPort,
  ).authorize({ userAccessToken: credential.accessToken, action: input.kind, resource: { kind: "fleet" } });
  return keycloakDecision(envelope, input.evaluatedAtCut, result.outcome, result.reasonCode);
}

/** Host-level authority: the daemon's socket owner locally, anyone else through a Keycloak fleet grant. */
export async function requireAuthorizedFleetAction(input: {
  readonly kind: string;
  readonly userRoot: string;
  readonly auth: DaemonAuthenticationContext;
  readonly actionId: string;
  readonly evaluatedAtCut: string;
  readonly now?: string;
  readonly fetchPort?: typeof fetch;
}): Promise<AuthorizationDecision> {
  const binding = await localSystemActionBinding(input.userRoot, input.kind, input.auth, () =>
    Promise.resolve(localDefaultBinding(input.auth)),
  );
  if (!binding.keycloakAuthorization) return requireAuthorizedHostAction({ ...input, binding });
  const decision = await evaluateFleetAction({ ...input, binding });
  if (decision.outcome === "denied")
    throw Object.assign(new Error(decision.nextActions.join(" ")), {
      code: "authorization_denied",
      authorizationDecision: decision,
    });
  return decision;
}
