import type { OidcAuthApi } from "@harness-anything/authorization-gui/oidc-auth-contract";
import { identityProviderOf, type IdentityProvider } from "@harness-anything/authorization-gui/identity-presentation";

/** Who is signed in and which provider owns the session, read as one snapshot from the identity port. */
export interface IdentitySnapshot {
  readonly authenticated: boolean;
  readonly personId?: string;
  readonly provider: IdentityProvider;
}

/**
 * Read the identity port: the session reply says who is signed in, the binding reply says which
 * provider owns the session. The binding may fail without hiding a session the daemon already
 * confirmed; an unreadable binding stays `unknown` rather than assuming Keycloak.
 */
export async function readIdentity(
  auth: OidcAuthApi,
  repoId: string | undefined,
  rootDir: string | undefined,
): Promise<IdentitySnapshot> {
  const [session, binding] = await Promise.allSettled([
    auth.status(repoId, rootDir),
    auth.bindingStatus(repoId, rootDir),
  ]);
  if (session.status === "rejected") throw session.reason;
  const reply = session.value as { readonly authenticated?: unknown; readonly personId?: unknown };
  return {
    authenticated: reply.authenticated === true,
    ...(reply.personId ? { personId: String(reply.personId) } : {}),
    provider:
      binding.status === "fulfilled"
        ? identityProviderOf((binding.value as { readonly mode?: unknown } | null)?.mode)
        : "unknown",
  };
}
