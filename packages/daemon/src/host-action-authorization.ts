import { composeDurableActionEnvelope } from "@harness-anything/application/internal/durable-action-envelope";
import { actionDeclarations, type AuthorizationDecision } from "@harness-anything/kernel";
import { localDefaultBinding, localSystemActionBinding } from "./daemon-host-binding.ts";
import { evaluateKeycloakPerson, keycloakDecision } from "./repo-cell-authorization.ts";
import type { RepoCellBinding } from "./repo-cell-types.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";

export async function requireAuthorizedHostAction(
  input: Parameters<typeof evaluateFleetAction>[0],
): Promise<AuthorizationDecision> {
  const decision = await evaluateFleetAction(input);
  if (decision.outcome === "denied")
    throw Object.assign(new Error(decision.nextActions.join(" ")), {
      code: "authorization_denied",
      authorizationDecision: decision,
    });
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
  const declaration = actionDeclarations.find((candidate) => candidate.kind === input.kind);
  if (input.binding.source === "local" && input.binding.daemonSocketOwner === true && declaration)
    return {
      ...keycloakDecision(envelope, input.evaluatedAtCut, "allowed", "daemon_socket_owner"),
      policyRef: "daemon-socket-owner@1",
      bindingsUsed: [{ proof: "unix-socket-owner-boundary", scope: input.kind }],
    };
  if (!credential) {
    return keycloakDecision(envelope, input.evaluatedAtCut, "denied", "authentication_required");
  }
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
  return requireAuthorizedHostAction({ ...input, binding });
}
