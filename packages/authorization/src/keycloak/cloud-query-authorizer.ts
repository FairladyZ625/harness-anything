import { KeycloakPolicyAdapter, type KeycloakPolicyAdapterConfig } from "./keycloak-policy-adapter.ts";

export type CloudQueryAuthorizationOutcome =
  | { readonly outcome: "allowed"; readonly personId: string }
  | { readonly outcome: "unauthenticated" }
  | { readonly outcome: "denied" }
  | { readonly outcome: "unavailable" };

export interface KeycloakCloudQueryAuthorizer {
  readonly authorizeRepositoryRead: (input: {
    readonly token: string;
    readonly repoId: string;
    readonly signal: AbortSignal;
  }) => Promise<CloudQueryAuthorizationOutcome>;
}

class IdentityAuthorityUnavailableError extends Error {
  readonly code = "identity_unavailable";

  constructor(cause: unknown) {
    super("Identity authority unavailable.", { cause });
  }
}

/** Provider-owned Keycloak OIDC + UMA authorizer for stateless cloud read hosts. */
export function createKeycloakCloudQueryAuthorizer(
  config: KeycloakPolicyAdapterConfig,
  fetchPort: typeof globalThis.fetch = globalThis.fetch,
): KeycloakCloudQueryAuthorizer {
  const authority = new URL(config.url);
  if (authority.protocol !== "https:" || authority.username || authority.password || authority.search || authority.hash)
    throw new TypeError("Cloud queries require a configured HTTPS identity authority.");
  const userinfoUrl = `${authority.href.replace(/\/$/u, "")}/realms/${encodeURIComponent(config.realm)}/protocol/openid-connect/userinfo`;
  return {
    async authorizeRepositoryRead({ token, repoId, signal }) {
      const fetchAuthority: typeof globalThis.fetch = (url, init) =>
        fetchPort(url, { ...init, signal, redirect: "error" });
      const identity = await fetchAuthority(userinfoUrl, { headers: { authorization: `Bearer ${token}` } });
      if (identity.status === 401 || identity.status === 403) return { outcome: "unauthenticated" };
      if (!identity.ok) return { outcome: "unavailable" };
      const { harness_person_id: personId } = (await identity.json()) as { readonly harness_person_id?: unknown };
      if (typeof personId !== "string" || !personId || personId.includes("/")) return { outcome: "unauthenticated" };
      const adapter = new KeycloakPolicyAdapter(config, fetchAuthority);
      try {
        const decision = await adapter.authorize({
          userAccessToken: token,
          action: "repository-read",
          resource: { kind: "repository", repoId },
        });
        return decision.outcome === "allowed" ? { outcome: "allowed", personId } : { outcome: "denied" };
      } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        if (code === "keycloak_admin_rejected" || code === "daemon_error")
          throw new IdentityAuthorityUnavailableError(error);
        throw error;
      }
    },
  };
}
