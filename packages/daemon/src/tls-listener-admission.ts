import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";

export function validateCertificateNames(cert: Buffer, names: readonly string[]): void {
  const certificate = new X509Certificate(cert);
  for (const name of names) {
    const covered =
      isIP(name) === 0 ? certificate.checkHost(name) !== undefined : certificate.checkIP(name) !== undefined;
    if (!covered) {
      throw Object.assign(
        new Error(`TLS certificate SAN does not cover ${name}; add ${name} to the certificate and retry.`),
        { code: "cert_san_mismatch", name },
      );
    }
  }
}

export function mapListenerBindError(error: unknown): Error {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
  if (code === "EADDRINUSE" || code === "EADDRNOTAVAIL" || code === "EACCES") {
    const message = error instanceof Error ? error.message : String(error);
    return Object.assign(new Error(`Fleet TLS listener could not bind (${code}): ${message}`), { code });
  }
  return error instanceof Error ? error : new Error(String(error));
}
