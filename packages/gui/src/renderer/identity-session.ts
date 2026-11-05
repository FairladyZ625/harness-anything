import type { OidcAuthApi } from "@harness-anything/authorization-gui/oidc-auth-contract";
import { identityProviderOf, type IdentityProvider } from "@harness-anything/authorization-gui/identity-presentation";

/**
 * The identity port answers one of two things: a confirmed session state (signed in or signed
 * out), or a failed read that can say nothing about the account. `unavailable` is deliberately
 * distinct from signed out: a temporary identity-service failure must not be presented as an
 * ended session, and it must not leave the previous person on screen.
 */
export type IdentitySnapshot =
  | {
      readonly phase: "ready";
      readonly authenticated: true;
      readonly personId: string;
      readonly provider: IdentityProvider;
    }
  | {
      readonly phase: "ready";
      readonly authenticated: false;
      readonly provider: IdentityProvider;
    }
  | { readonly phase: "unavailable"; readonly provider: IdentityProvider };

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
  const provider =
    binding.status === "fulfilled"
      ? identityProviderOf((binding.value as { readonly mode?: unknown } | null)?.mode)
      : "unknown";
  if (session.status === "rejected") return { phase: "unavailable", provider };
  const reply = session.value as { readonly authenticated?: unknown; readonly personId?: unknown };
  return reply.authenticated === true
    ? {
        phase: "ready",
        authenticated: true,
        personId: reply.personId ? String(reply.personId) : "",
        provider,
      }
    : { phase: "ready", authenticated: false, provider };
}
