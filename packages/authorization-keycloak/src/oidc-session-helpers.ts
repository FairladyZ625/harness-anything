import type { OidcLoginAuthority } from "@harness-anything/kernel";

export function clientFields(authority: OidcLoginAuthority): Record<string, string> {
  return {
    client_id: authority.clientId,
    ...(authority.clientSecret ? { client_secret: authority.clientSecret } : {}),
  };
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw coded("oidc_token_invalid", "Keycloak returned an invalid access token.");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

export function realmRoles(claims: Record<string, unknown>): readonly string[] {
  const access = claims.realm_access;
  if (!access || typeof access !== "object" || Array.isArray(access)) return [];
  const roles = (access as Record<string, unknown>).roles;
  return Array.isArray(roles) ? roles.filter((role): role is string => typeof role === "string") : [];
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw coded("oidc_response_invalid", `Keycloak omitted ${field}.`);
  return value;
}

export function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw coded("oidc_response_invalid", `Keycloak omitted ${field}.`);
  return value;
}

export function unavailable(message: string, cause?: unknown): Error {
  return Object.assign(coded("oidc_session_unavailable", message), cause === undefined ? {} : { cause });
}

export function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const transientTransportCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** Recognizes Node fetch's structured network failures so lifecycle callers can use their existing bounded waits. */
export function transientTransportFailure(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  let cause: unknown = error,
    depth = 0;
  while (cause !== undefined && depth < 4) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      typeof cause.code === "string" &&
      transientTransportCodes.has(cause.code)
    )
      return true;
    cause = cause instanceof Error ? cause.cause : undefined;
    depth += 1;
  }
  return false;
}
