/**
 * Keycloak transport failures are the adapters' coded `daemon_error` sentinel (userinfo, Admin
 * REST, center-token acquisition), or a raw fetch rejection that never reached an HTTP status.
 *
 * Only callers that can prove the request had not started its durable write may translate these
 * into `keycloak_unavailable`. Admin REST writes (whose response may be lost after Keycloak
 * applied them) keep the original code and the existing intent/reconcile path.
 */
export function isKeycloakTransportFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { readonly code?: unknown }).code,
    name = (error as { readonly name?: unknown }).name,
    message = (error as { readonly message?: unknown }).message;
  if (code === "daemon_error") return true;
  if (
    typeof code === "string" &&
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH"].includes(code)
  )
    return true;
  if (typeof code === "string") return false;
  if (name === "AbortError" || (typeof message === "string" && message === "fetch failed")) return true;
  const cause = (error as { readonly cause?: unknown }).cause;
  return cause !== undefined && cause !== error && isKeycloakTransportFailure(cause);
}

export function keycloakUnavailableFailure(error: unknown, phase: string): Error {
  return Object.assign(
    new Error(
      `The daemon could not reach the Keycloak identity authority while ${phase} ` +
        "(the daemon may still be starting its managed identity services), so the request was not applied. " +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    ),
    { code: "keycloak_unavailable" },
  );
}
