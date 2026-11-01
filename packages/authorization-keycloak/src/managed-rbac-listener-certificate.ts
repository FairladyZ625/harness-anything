import { createHash, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";
import type { ManagedRbacHost } from "./managed-host.ts";

import type { CertificateMode, ManagedRbacListener, ManagedRbacRequest } from "@harness-anything/kernel";

function selfSignedCertificatePaths(root: string): {
  readonly certificateFile: string;
  readonly certificateKeyFile: string;
} {
  const directory = path.join(root, "listener");
  return {
    certificateFile: path.join(directory, "self-signed.pem"),
    certificateKeyFile: path.join(directory, "self-signed.key"),
  };
}

function existingCertificateIsCurrent(
  certificateFile: string,
  names: readonly string[],
  validateCertificateNames: ManagedRbacHost["validateCertificateNames"],
): boolean {
  const certificatePem = readFileSync(certificateFile),
    certificate = new X509Certificate(certificatePem),
    now = Date.now();
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) return false;
  try {
    validateCertificateNames(certificatePem, names);
    return true;
  } catch (error) {
    if (error instanceof Error && (error as { readonly code?: unknown }).code === "cert_san_mismatch") return false;
    throw error;
  }
}

export function firstReachableAddress(): string {
  for (const entries of Object.values(networkInterfaces()))
    for (const entry of entries ?? []) if (entry.family === "IPv4" && !entry.internal) return entry.address;
  return "127.0.0.1";
}

export async function ensureSelfSignedCertificate(
  root: string,
  hostname: string,
  address: string,
  host: ManagedRbacHost,
): Promise<{ readonly certificateFile: string; readonly certificateKeyFile: string }> {
  const { certificateFile, certificateKeyFile } = selfSignedCertificatePaths(root),
    names = [address, hostname];
  if (existsSync(certificateFile) && existsSync(certificateKeyFile)) {
    if (existingCertificateIsCurrent(certificateFile, names, host.validateCertificateNames)) {
      chmodSync(certificateKeyFile, 0o600);
      return { certificateFile, certificateKeyFile };
    }
  }
  rmSync(certificateFile, { force: true });
  rmSync(certificateKeyFile, { force: true });
  mkdirSync(path.dirname(certificateFile), { recursive: true, mode: 0o700 });
  const san = isIP(hostname) !== 0 ? `IP:${hostname}` : `DNS:${hostname}`;
  const addressSan = address === hostname ? "" : isIP(address) !== 0 ? `,IP:${address}` : `,DNS:${address}`;
  try {
    await host.runProcessTextAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      certificateKeyFile,
      "-out",
      certificateFile,
      "-subj",
      `/CN=${hostname}`,
      "-days",
      "825",
      "-addext",
      `subjectAltName=${san}${addressSan}`,
    ]);
    chmodSync(certificateKeyFile, 0o600);
    chmodSync(certificateFile, 0o644);
    host.validateCertificateNames(readFileSync(certificateFile), names);
    return { certificateFile, certificateKeyFile };
  } catch (error) {
    rmSync(certificateFile, { force: true });
    rmSync(certificateKeyFile, { force: true });
    throw Object.assign(
      new Error(
        `Could not create the self-signed login certificate: ${error instanceof Error ? error.message : String(error)}`,
      ),
      {
        code: "rbac_listener_certificate_failed",
      },
    );
  }
}

export function removeSelfSignedCertificate(root: string): void {
  const { certificateFile, certificateKeyFile } = selfSignedCertificatePaths(root);
  rmSync(certificateFile, { force: true });
  rmSync(certificateKeyFile, { force: true });
}

export function publicListener(listener: ManagedRbacListener): Omit<ManagedRbacListener, "certificateKeyFile"> {
  const { certificateKeyFile: _privateKey, ...safe } = listener;
  return safe;
}

export function listenerVersion(listener: ManagedRbacListener | undefined, certificateMode?: CertificateMode): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        listener: listener ?? null,
        certificateMode: certificateMode ?? (listener ? "domain" : "self-signed"),
      }),
    )
    .digest("hex");
}

export function validateListenerInput(
  address: string | undefined,
  hostname: string | undefined,
  port: number | undefined,
): { readonly address: string; readonly hostname: string; readonly port: number } {
  // DNS names are case-insensitive and URL parsing lower-cases them; normalize before comparing so a
  // mixed-case hostname from the certificate is accepted as the name Keycloak will use as its issuer.
  const normalizedHostname = hostname?.toLowerCase();
  if (
    !address ||
    isIP(address) === 0 ||
    !normalizedHostname ||
    !Number.isInteger(port) ||
    port === undefined ||
    port < 1 ||
    port > 65_535 ||
    !URL.canParse(`https://${normalizedHostname}:${port}`) ||
    new URL(`https://${normalizedHostname}:${port}`).hostname !== normalizedHostname
  )
    throw listenerError("A listener takes --hostname (as the certificate names it), --port, and an IP listen address.");
  return { address, hostname: normalizedHostname, port };
}

export function requestedListener(request: ManagedRbacRequest): ManagedRbacListener | undefined {
  const { hostname, port, certificateFile, certificateKeyFile } = request;
  const supplied = [request.listenAddress, hostname, port, certificateFile, certificateKeyFile].every(
    (value) => value === undefined,
  );
  if (supplied) {
    if (request.certificateMode === "domain" || request.certificateMode === "internal-ca")
      throw listenerError("A domain or internal CA listener requires a hostname, port, certificate, and private key.");
    return undefined;
  }
  const address = request.listenAddress ?? (request.certificateMode ? "0.0.0.0" : firstReachableAddress());
  const endpoint = validateListenerInput(address, hostname, port);
  if (
    !certificateFile ||
    !certificateKeyFile ||
    !path.isAbsolute(certificateFile) ||
    !path.isAbsolute(certificateKeyFile) ||
    !existsSync(certificateFile)
  )
    throw listenerError(
      "A listener takes --hostname (as the certificate names it), --port, and absolute --certificate-file and --certificate-key-file paths. Pass none of them to serve loopback only.",
    );
  return { ...endpoint, certificateFile, certificateKeyFile };
}

function listenerError(message: string): Error {
  return Object.assign(new Error(message), { code: "rbac_listener_invalid" });
}
