/**
 * The identity provider named by an OIDC binding mode. The daemon's binding reply reports
 * `builtin` for the local identity service and `managed`/`external` for a Keycloak authority.
 * Anything else — including a reply that has not arrived or failed — is `unknown`, so a caller
 * must not claim either provider from an absent mode.
 */
export type IdentityProvider = "builtin" | "keycloak" | "unknown";

export function identityProviderOf(mode: unknown): IdentityProvider {
  if (mode === "builtin") return "builtin";
  return mode === "managed" || mode === "external" ? "keycloak" : "unknown";
}
