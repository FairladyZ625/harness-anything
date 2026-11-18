import { createHash, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

function uploadedCertificatePaths(root: string): {
  readonly certificateFile: string;
  readonly certificateKeyFile: string;
} {
  const directory = path.join(root, "listener");
  return {
    certificateFile: path.join(directory, "listener.pem"),
    certificateKeyFile: path.join(directory, "listener.key"),
  };
}

export function isManagedListenerPath(root: string, filePath: string): boolean {
  const listenerDirectory = path.resolve(root, "listener"),
    relative = path.relative(listenerDirectory, path.resolve(filePath));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function isManagedListenerPair(
  root: string,
  listener: Pick<ManagedRbacListener, "certificateFile" | "certificateKeyFile">,
): boolean {
  return (
    isManagedListenerPath(root, listener.certificateFile) && isManagedListenerPath(root, listener.certificateKeyFile)
  );
}

class ListenerKeyExposedError extends Error {
  readonly code = "rbac_listener_key_exposed";
}

export function listenerMaterialProblem(
  listener: Pick<ManagedRbacListener, "certificateFile" | "certificateKeyFile">,
): "missing_certificate" | "exposed_key" | undefined {
  if (!existsSync(listener.certificateFile) || !statSync(listener.certificateFile).isFile())
    return "missing_certificate";
  if (
    !existsSync(listener.certificateKeyFile) ||
    !statSync(listener.certificateKeyFile).isFile() ||
    (statSync(listener.certificateKeyFile).mode & 0o077) !== 0
  )
    return "exposed_key";
  return undefined;
}

export function requirePrivateKeyFile(file: string): void {
  const mode = existsSync(file) && statSync(file).isFile() ? statSync(file).mode & 0o777 : undefined;
  if (mode === undefined || (mode & 0o077) !== 0)
    throw new ListenerKeyExposedError(
      mode === undefined
        ? "The listener's private key must be present and readable only by its owner (chmod 600)."
        : "The listener's private key must be readable only by its owner (chmod 600).",
    );
}

function writeManagedFileAtomically(file: string, content: Buffer, mode: number): void {
  const temporary = `${file}.tmp`;
  /* @gate-identity state-store/runtime-instance.authorization-configuration */ writeFileSync(temporary, content, {
    mode,
  });
  chmodSync(temporary, mode);
  /* @gate-identity state-store/runtime-instance.authorization-configuration */ renameSync(temporary, file);
  chmodSync(file, mode);
}

export interface UploadedCertificateSnapshot {
  readonly certificateBytes?: Buffer;
  readonly keyBytes?: Buffer;
}

export function snapshotUploadedCertificate(root: string): UploadedCertificateSnapshot {
  const { certificateFile, certificateKeyFile } = uploadedCertificatePaths(root);
  return {
    ...(existsSync(certificateFile) && statSync(certificateFile).isFile()
      ? { certificateBytes: readFileSync(certificateFile) }
      : {}),
    ...(existsSync(certificateKeyFile) && statSync(certificateKeyFile).isFile()
      ? { keyBytes: readFileSync(certificateKeyFile) }
      : {}),
  };
}

export function restoreUploadedCertificate(root: string, snapshot: UploadedCertificateSnapshot): void {
  const { certificateFile, certificateKeyFile } = uploadedCertificatePaths(root);
  if (snapshot.certificateBytes === undefined || snapshot.keyBytes === undefined) {
    removeUploadedCertificate(root);
    return;
  }
  const directory = path.dirname(certificateFile);
  /* @gate-identity state-store/runtime-instance.authorization-configuration */ mkdirSync(directory, {
    recursive: true,
    mode: 0o700,
  });
  chmodSync(directory, 0o700);
  writeManagedFileAtomically(certificateFile, snapshot.certificateBytes, 0o644);
  writeManagedFileAtomically(certificateKeyFile, snapshot.keyBytes, 0o600);
}

export function installUploadedCertificate(
  root: string,
  sourceCertificateFile: string,
  sourceKeyFile: string,
  names: readonly string[],
  validateCertificateNames: ManagedRbacHost["validateCertificateNames"],
): { readonly certificateFile: string; readonly certificateKeyFile: string } {
  if (!existsSync(sourceCertificateFile) || !statSync(sourceCertificateFile).isFile())
    throw listenerError(
      "A listener takes --hostname (as the certificate names it), --port, and absolute --certificate-file and --certificate-key-file paths. Pass none of them to serve loopback only.",
    );
  requirePrivateKeyFile(sourceKeyFile);
  const certificateBytes = readFileSync(sourceCertificateFile);
  validateCertificateNames(certificateBytes, names);
  const keyBytes = readFileSync(sourceKeyFile);
  const { certificateFile, certificateKeyFile } = uploadedCertificatePaths(root),
    directory = path.dirname(certificateFile);
  /* @gate-identity state-store/runtime-instance.authorization-configuration */ mkdirSync(directory, {
    recursive: true,
    mode: 0o700,
  });
  chmodSync(directory, 0o700);
  writeManagedFileAtomically(certificateFile, certificateBytes, 0o644);
  writeManagedFileAtomically(certificateKeyFile, keyBytes, 0o600);
  return { certificateFile, certificateKeyFile };
}

export function removeUploadedCertificate(root: string): void {
  const { certificateFile, certificateKeyFile } = uploadedCertificatePaths(root);
  /* @gate-identity state-store/runtime-instance.authorization-configuration */ rmSync(certificateFile, {
    force: true,
  });
  /* @gate-identity state-store/runtime-instance.authorization-configuration */ rmSync(certificateKeyFile, {
    force: true,
  });
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
  /* @gate-identity non-state/environment-io.773f1f24462e0efd */ rmSync(certificateFile, { force: true });
  /* @gate-identity non-state/environment-io.44f16540c48fcc72 */ rmSync(certificateKeyFile, { force: true });
  /* @gate-identity non-state/environment-io.580e80f3650a0879 */ mkdirSync(path.dirname(certificateFile), {
    recursive: true,
    mode: 0o700,
  });
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
    /* @gate-identity non-state/environment-io.778729626dd1b40c */ rmSync(certificateFile, { force: true });
    /* @gate-identity non-state/environment-io.8f59e38af283edd1 */ rmSync(certificateKeyFile, { force: true });
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
  /* @gate-identity non-state/environment-io.0437be7bf65098b0 */ rmSync(certificateFile, { force: true });
  /* @gate-identity non-state/environment-io.64dd2033f7d1c003 */ rmSync(certificateKeyFile, { force: true });
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
