import { composeDurableActionEnvelope } from "@harness-anything/application/internal/durable-action-envelope";
import { DEFAULT_POLICY, type AuthorizationContext, type AuthorizationDecision } from "@harness-anything/kernel";
import { authorizeAction } from "./authorization.ts";
import { localDefaultBinding, localSystemActionBinding } from "./daemon-host-binding.ts";
import { evaluateKeycloakPerson, keycloakDecision } from "./repo-cell-authorization.ts";
import type { RepoCellBinding } from "./repo-cell-types.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";

export function authorizeHostAction(input: {
  readonly kind: string;
  readonly binding: RepoCellBinding;
  readonly actionId: string;
  readonly evaluatedAtCut: string;
  readonly now?: string;
}): AuthorizationDecision {
  const context: AuthorizationContext = {
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

/**
 * A host-level action answers to the acting person's Keycloak grant on the fleet, or on the one
 * repository it reaches when the caller names it.
 */
export async function evaluateFleetAction(input: {
  readonly kind: string;
  readonly binding: RepoCellBinding;
  readonly actionId: string;
  readonly evaluatedAtCut: string;
  readonly repoId?: string;
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
  const result = await evaluateKeycloakPerson({
    credential,
    personId: input.binding.actor.principal.personId,
    action: input.kind,
    resource: input.repoId === undefined ? { kind: "fleet" } : { kind: "repository", repoId: input.repoId },
    fetchPort: input.fetchPort,
  });
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
