import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";

export function validateCertificateNames(cert: Buffer, names: readonly string[]): void {
  const certificate = new X509Certificate(cert);
  for (const name of names) {
    // A wildcard bind listens on every interface; edges reach it by a concrete name the certificate must
    // carry, which the listen address cannot tell.
    if (name === "0.0.0.0" || name === "::") continue;
    const covered =
      isIP(name) === 0
        ? certificate.checkHost(name, { subject: "never" }) !== undefined
        : certificate.checkIP(name) !== undefined;
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
    return Object.assign(new Error(`TLS listener could not bind (${code}): ${message}`), { code });
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** Local hairpin NAT can make an otherwise valid advertised address fail; callers report only a warning. */
export function probeTlsAddress(url: string, timeoutMs = 1_500): Promise<boolean> {
  const endpoint = new URL(url),
    hostname = endpoint.hostname.replace(/^\[|\]$/gu, ""),
    port = endpoint.port === "" ? 443 : Number(endpoint.port);
  return new Promise<boolean>((resolve) => {
    const socket = tlsConnect({
        host: hostname,
        port,
        rejectUnauthorized: false,
        ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
      }),
      timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, timeoutMs),
      finish = (reachable: boolean) => {
        clearTimeout(timer);
        socket.destroy();
        resolve(reachable);
      };
    socket.once("secureConnect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}
