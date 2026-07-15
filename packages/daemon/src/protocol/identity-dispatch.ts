import type {
  AuthenticatedActor,
  IdentityProvider,
  IdentityProviderFailure,
  PersonRegistry
} from "../identity/types.ts";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import type { JsonRpcMethodContract } from "./method-registry.ts";

export interface IdentityDispatchOptions {
  readonly authContext?: DaemonAuthenticationContext;
  readonly identityProvider?: IdentityProvider;
  readonly personRegistry?: PersonRegistry;
}

export async function resolveIdentityActorForMethod(
  contract: JsonRpcMethodContract,
  options: IdentityDispatchOptions
): Promise<{ readonly ok: true; readonly actor: AuthenticatedActor } | IdentityProviderFailure | undefined> {
  const authContext = options.authContext ?? { transportKind: "unix-socket" } satisfies DaemonAuthenticationContext;
  if (!options.identityProvider) {
    return authContext.sshForcedCommand || requiresAuthenticatedPrincipal(contract)
      ? identityFailure(
          "identity-provider/unavailable",
          "provider_unavailable",
          "Daemon writes require an identity provider to authenticate the principal. Local: run ha init with HARNESS_GIT_AUTHOR_NAME and HARNESS_GIT_AUTHOR_EMAIL set, or configure the current host/uid in ~/.harness/people.yaml. Remote: configure the repo roster and connect through the authorized_keys forced command."
        )
      : undefined;
  }
  if (!options.personRegistry) {
    return identityFailure(
      options.identityProvider.providerId,
      "person_registry_unavailable",
      "Authenticated daemon requests require a core person registry."
    );
  }
  const authentication = await options.identityProvider.authenticate(authContext);
  if (!authentication.ok) return authentication;
  const person = options.personRegistry.find(authentication.personId);
  if (!person) {
    return identityFailure(
      options.identityProvider.providerId,
      "person_unregistered",
      `Identity provider authenticated an unregistered personId: ${authentication.personId}`,
      authentication.credential
    );
  }
  if (person.disabled) {
    return identityFailure(
      options.identityProvider.providerId,
      "person_disabled",
      `Person is disabled: ${person.personId}`,
      authentication.credential
    );
  }
  return {
    ok: true,
    actor: {
      personId: person.personId,
      displayName: person.displayName,
      ...(authentication.primaryEmail ? { primaryEmail: authentication.primaryEmail } : {}),
      resolvedCredential: authentication.credential,
      providerId: authentication.providerId
    }
  };
}

function requiresAuthenticatedPrincipal(contract: JsonRpcMethodContract): boolean {
  return contract.commandClass !== "repo-read";
}

function identityFailure(
  providerId: string,
  code: IdentityProviderFailure["code"],
  message: string,
  credential?: IdentityProviderFailure["credential"]
): IdentityProviderFailure {
  return { ok: false, code, providerId, message, ...(credential ? { credential } : {}) };
}
