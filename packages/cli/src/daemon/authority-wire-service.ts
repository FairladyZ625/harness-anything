import {
  createJsonRpcProtocolServer,
  canonicalRootIdentity,
  resolveAuthorityConnectionForRequest,
  type AuthorityWireIngressHandler,
  type DaemonRepoNamespace,
  type IdentityProvider,
  type PersonRegistry
} from "@harness-anything/daemon";
import type { AuthorityRepoLifecycleController } from "./authority-lifecycle.ts";

export interface AuthorityWireRepoBinding {
  readonly repo: DaemonRepoNamespace;
  readonly identity: {
    readonly identityProvider?: IdentityProvider;
    readonly personRegistry?: PersonRegistry;
  };
}

export function createAuthorityWireIngressHandler(input: {
  readonly authorityLifecycle?: AuthorityRepoLifecycleController;
  readonly repoBindings: () => Iterable<AuthorityWireRepoBinding>;
}): AuthorityWireIngressHandler {
  return async (request) => {
    if (!input.authorityLifecycle) throw new Error("AUTHORITY_PRODUCTION_LIFECYCLE_DISABLED");
    const repoBinding = [...input.repoBindings()].find((binding) =>
      canonicalRootIdentity(binding.repo.canonicalRoot) === canonicalRootIdentity(request.bootstrap.canonicalRoot)
    );
    if (!repoBinding) throw new Error("AUTHORITY_WIRE_REPO_UNAVAILABLE");
    const provider = repoBinding.identity.identityProvider;
    const registry = repoBinding.identity.personRegistry;
    if (!provider || !registry) throw new Error("AUTHORITY_WIRE_IDENTITY_UNAVAILABLE");
    const authenticated = await provider.authenticate(request.authContext);
    if (!authenticated.ok || authenticated.personId !== request.bootstrap.personId) {
      throw new Error("AUTHORITY_WIRE_IDENTITY_REJECTED");
    }
    const person = registry.find(authenticated.personId);
    if (!person || person.disabled) throw new Error("AUTHORITY_WIRE_PERSON_UNAVAILABLE");
    const authorized = await provider.authorize({
      personId: authenticated.personId,
      action: { method: "authority.submit", commandClass: "repo-write" },
      resource: {
        repoId: repoBinding.repo.repoId,
        canonicalRoot: repoBinding.repo.canonicalRoot
      }
    });
    if (!authorized.ok) throw new Error("AUTHORITY_WIRE_RBAC_REJECTED");
    const actor = {
      personId: authenticated.personId,
      displayName: person.displayName,
      ...(authenticated.primaryEmail ? { primaryEmail: authenticated.primaryEmail } : {}),
      providerId: authenticated.providerId,
      resolvedCredential: authenticated.credential
    };
    const dispatch = await resolveAuthorityConnectionForRequest({
      acceptedConnection: request.acceptedConnection,
      actor,
      repo: repoBinding.repo,
      peerPolicy: sshAuthorityWirePeerPolicy
    });
    if (!dispatch?.available) {
      throw new Error(`AUTHORITY_WIRE_CONNECTION_REJECTED:${dispatch?.code ?? "unavailable"}`);
    }
    dispatch.assertActive();
    const component = input.authorityLifecycle.component(repoBinding.repo.repoId);
    if (!component) throw new Error("AUTHORITY_WIRE_COMPONENT_UNAVAILABLE");
    const connection = component.bindConnection(dispatch.context);
    if (!connection.serveForcedCommand) throw new Error("AUTHORITY_WIRE_SESSION_UNAVAILABLE");
    return connection.serveForcedCommand({ input: request.input, output: request.output });
  };
}

export function sshAuthorityWirePeerPolicy(input: Parameters<NonNullable<
  Parameters<typeof createJsonRpcProtocolServer>[0]["authorityPeerPolicy"]
>>[0]): boolean {
  const daemonUid = process.getuid?.();
  return input.actor.resolvedCredential.kind === "ssh-forced-command-person"
    && typeof daemonUid === "number"
    && input.peerCredential.uid === daemonUid;
}
