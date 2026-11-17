/** Node/undici retain OpenSSL certificate failures in fetch's cause chain. */
const certificateCodes = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "INVALID_CA",
  "CERT_SIGNATURE_FAILURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED",
  "CERT_UNTRUSTED",
  "INVALID_PURPOSE",
]);

/** Keep certificate misconfiguration distinct from retryable identity authority outages. */
export function keycloakTlsFailure(cause: unknown): Error | undefined {
  const seen = new Set<object>();
  let current = cause;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const error = current as { readonly code?: unknown; readonly cause?: unknown };
    if (error.code === "keycloak_tls_certificate_error" && current instanceof Error) return current;
    if (typeof error.code === "string" && certificateCodes.has(error.code))
      return new KeycloakTlsCertificateError(error.code, cause);
    current = error.cause;
  }
  return undefined;
}

class KeycloakTlsCertificateError extends Error {
  readonly code = "keycloak_tls_certificate_error";
  readonly certificateCode: string;
  constructor(certificateCode: string, cause: unknown) {
    super(
      `Keycloak TLS certificate verification failed (${certificateCode}). ` +
        "Check the configured center/login CA certificate, certificate chain and servername/hostname; " +
        "renew expired certificates. TLS verification remains required.",
      { cause },
    );
    this.certificateCode = certificateCode;
  }
}
