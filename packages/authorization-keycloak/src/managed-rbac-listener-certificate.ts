import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";
import type { ManagedRbacHost } from "./managed-host.ts";

import type { CertificateMode, ManagedRbacListener, ManagedRbacRequest } from "@harness-anything/kernel";

const pemCertificateBlock = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu;

export type ListenerMaterialProblem = "missing_certificate" | "exposed_key" | "invalid_material";

export class ListenerKeyExposedError extends Error {
  readonly code = "rbac_listener_key_exposed";
}

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

function createUploadedCertificateVersionPaths(root: string): {
  readonly directory: string;
  readonly certificateFile: string;
  readonly certificateKeyFile: string;
  readonly generation: string;
} {
  const generation = randomBytes(12).toString("hex"),
    directory = path.join(root, "listener", `uploaded-${generation}`);
  return {
    generation,
    directory,
    certificateFile: path.join(directory, "listener.pem"),
    certificateKeyFile: path.join(directory, "listener.key"),
  };
}

export function isManagedListenerPath(root: string, filePath: string): boolean {
  const listenerDirectory = path.join(root, "listener");
  if (!existsSync(listenerDirectory)) return false;
  const rootStats = lstatSync(listenerDirectory);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) return false;
  const resolvedRoot = path.resolve(listenerDirectory),
    resolvedTarget = path.resolve(filePath),
    relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  let current = resolvedRoot;
  const segments = relative.split(path.sep);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    if (!existsSync(current)) return false;
    const stats = lstatSync(current);
    if (stats.isSymbolicLink()) return false;
    if (index < segments.length - 1 && !stats.isDirectory()) return false;
    if (index === segments.length - 1 && !stats.isFile()) return false;
  }
  const realRoot = realpathSync(resolvedRoot),
    realTarget = realpathSync(resolvedTarget),
    realRelative = path.relative(realRoot, realTarget);
  return realRelative !== "" && !realRelative.startsWith("..") && !path.isAbsolute(realRelative);
}

export function isManagedListenerPair(
  root: string,
  listener: Pick<ManagedRbacListener, "certificateFile" | "certificateKeyFile">,
): boolean {
  return (
    isManagedListenerPath(root, listener.certificateFile) && isManagedListenerPath(root, listener.certificateKeyFile)
  );
}

function readRegularFileWithStats(
  filePath: string,
  options: { readonly requireOwnerOnlyMode?: boolean } = {},
): { readonly bytes: Buffer; readonly mode: number } {
  let fd: number;
  try {
    fd = /* @gate-identity state-store/runtime-instance.authorization-configuration */ openSync(
      filePath,
      constants.O_RDONLY,
    );
  } catch {
    if (options.requireOwnerOnlyMode)
      throw new ListenerKeyExposedError(
        "The listener's private key must be present and readable only by its owner (chmod 600).",
      );
    throw listenerError(
      "A listener takes --hostname (as the certificate names it), --port, and absolute --certificate-file and --certificate-key-file paths. Pass none of them to serve loopback only.",
    );
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      if (options.requireOwnerOnlyMode)
        throw new ListenerKeyExposedError(
          "The listener's private key must be present and readable only by its owner (chmod 600).",
        );
      throw listenerError(
        "A listener takes --hostname (as the certificate names it), --port, and absolute --certificate-file and --certificate-key-file paths. Pass none of them to serve loopback only.",
      );
    }
    if (options.requireOwnerOnlyMode && (stats.mode & 0o077) !== 0)
      throw new ListenerKeyExposedError("The listener's private key must be readable only by its owner (chmod 600).");
    return { bytes: readFileSync(fd), mode: stats.mode & 0o777 };
  } finally {
    /* @gate-identity state-store/runtime-instance.authorization-configuration */ closeSync(fd);
  }
}

export function validateCertificateChainAndKeyPair(
  certificateBytes: Buffer,
  keyBytes: Buffer,
  names?: readonly string[],
  validateCertificateNames?: ManagedRbacHost["validateCertificateNames"],
): void {
  const certificateText = certificateBytes.toString("utf8"),
    blocks = [...certificateText.matchAll(pemCertificateBlock)].map(([block]) => block),
    remainder = certificateText.replace(pemCertificateBlock, "").trim();
  if (blocks.length === 0 || remainder !== "")
    throw listenerError("The listener certificate must contain valid PEM certificate blocks.");
  let certificates: X509Certificate[];
  try {
    certificates = blocks.map((block) => new X509Certificate(block));
  } catch {
    throw listenerError("The listener certificate contains malformed X.509 PEM data.");
  }
  for (let index = 1; index < certificates.length; index += 1) {
    const child = certificates[index - 1]!,
      issuer = certificates[index]!;
    if (!child.checkIssued(issuer) || !child.verify(issuer.publicKey))
      throw listenerError("The listener certificate chain is invalid or out of order.");
  }
  if (names && validateCertificateNames) validateCertificateNames(certificateBytes, names);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(keyBytes);
  } catch {
    throw listenerError("The listener private key must be a valid unencrypted PEM private key.");
  }
  const certPublicKey = certificates[0]!.publicKey.export({ type: "spki", format: "der" }),
    keyPublicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  if (!certPublicKey.equals(keyPublicKey))
    throw listenerError("The listener private key does not match the certificate.");
}

export function listenerMaterialProblem(
  listener: Pick<ManagedRbacListener, "certificateFile" | "certificateKeyFile" | "address" | "hostname">,
  validateCertificateNames?: ManagedRbacHost["validateCertificateNames"],
): ListenerMaterialProblem | undefined {
  let keyBytes: Buffer;
  try {
    keyBytes = readRegularFileWithStats(listener.certificateKeyFile, { requireOwnerOnlyMode: true }).bytes;
  } catch {
    return "exposed_key";
  }
  let certificateBytes: Buffer;
  try {
    certificateBytes = readRegularFileWithStats(listener.certificateFile).bytes;
  } catch {
    return "missing_certificate";
  }
  try {
    validateCertificateChainAndKeyPair(
      certificateBytes,
      keyBytes,
      validateCertificateNames ? [listener.address, listener.hostname] : undefined,
      validateCertificateNames,
    );
  } catch {
    return "invalid_material";
  }
  return undefined;
}

export function managedListenerProblem(
  userRoot: string,
  validateCertificateNames?: ManagedRbacHost["validateCertificateNames"],
): ListenerMaterialProblem | undefined {
  const configFile = path.join(userRoot, "rbac", "config.json");
  if (!existsSync(configFile)) return undefined;
  const config = JSON.parse(readFileSync(configFile, "utf8")) as unknown;
  if (!config || typeof config !== "object") return undefined;
  const record = config as {
    readonly mode?: unknown;
    readonly listener?: {
      readonly address?: unknown;
      readonly hostname?: unknown;
      readonly certificateFile?: unknown;
      readonly certificateKeyFile?: unknown;
    };
  };
  if (record.mode !== "managed" || !record.listener || typeof record.listener !== "object") return undefined;
  const { address, hostname, certificateFile, certificateKeyFile } = record.listener;
  if (typeof certificateKeyFile !== "string") return "exposed_key";
  if (typeof certificateFile !== "string") return "missing_certificate";
  return listenerMaterialProblem(
    {
      address: typeof address === "string" ? address : "",
      hostname: typeof hostname === "string" ? hostname : "",
      certificateFile,
      certificateKeyFile,
    },
    typeof address === "string" && typeof hostname === "string" ? validateCertificateNames : undefined,
  );
}

export function requirePrivateKeyFile(file: string): void {
  readRegularFileWithStats(file, { requireOwnerOnlyMode: true });
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

export interface SelfSignedCertificateSnapshot {
  readonly certificateBytes: Buffer;
  readonly keyBytes: Buffer;
}

export function snapshotSelfSignedCertificate(root: string): SelfSignedCertificateSnapshot | undefined {
  const { certificateFile, certificateKeyFile } = selfSignedCertificatePaths(root);
  if (!existsSync(certificateFile) || !existsSync(certificateKeyFile)) return undefined;
  const certStats = lstatSync(certificateFile),
    keyStats = lstatSync(certificateKeyFile);
  if (!certStats.isFile() || !keyStats.isFile() || (keyStats.mode & 0o077) !== 0) return undefined;
  return {
    certificateBytes: readFileSync(certificateFile),
    keyBytes: readFileSync(certificateKeyFile),
  };
}

export function restoreSelfSignedCertificate(root: string, snapshot: SelfSignedCertificateSnapshot): void {
  const { certificateFile, certificateKeyFile } = selfSignedCertificatePaths(root),
    directory = path.dirname(certificateFile);
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
  onWriteStage?: (stage: "certificate" | "key") => void,
): { readonly certificateFile: string; readonly certificateKeyFile: string; readonly generation: string } {
  const certificateBytes = readRegularFileWithStats(sourceCertificateFile).bytes,
    keyBytes = readRegularFileWithStats(sourceKeyFile, { requireOwnerOnlyMode: true }).bytes;
  validateCertificateChainAndKeyPair(certificateBytes, keyBytes, names, validateCertificateNames);
  const listenerDirectory = path.join(root, "listener"),
    { directory, certificateFile, certificateKeyFile, generation } = createUploadedCertificateVersionPaths(root);
  /* @gate-identity state-store/runtime-instance.authorization-configuration */ mkdirSync(listenerDirectory, {
    recursive: true,
    mode: 0o700,
  });
  chmodSync(listenerDirectory, 0o700);
  /* @gate-identity state-store/runtime-instance.authorization-configuration */ mkdirSync(directory, {
    recursive: true,
    mode: 0o700,
  });
  chmodSync(directory, 0o700);
  try {
    onWriteStage?.("certificate");
    writeManagedFileAtomically(certificateFile, certificateBytes, 0o644);
    onWriteStage?.("key");
    writeManagedFileAtomically(certificateKeyFile, keyBytes, 0o600);
  } catch (error) {
    /* @gate-identity state-store/runtime-instance.authorization-configuration */ rmSync(directory, {
      recursive: true,
      force: true,
    });
    throw error;
  }
  return { certificateFile, certificateKeyFile, generation };
}

export function pruneUploadedCertificateVersions(
  root: string,
  activeListener?: Pick<ManagedRbacListener, "certificateFile" | "certificateKeyFile">,
  previousListener?: Pick<ManagedRbacListener, "certificateFile" | "certificateKeyFile">,
): void {
  const listenerDirectory = path.join(root, "listener");
  if (!existsSync(listenerDirectory)) return;
  const resolvedListenerDirectory = path.resolve(listenerDirectory),
    activeDirectory = activeListener ? path.dirname(path.resolve(activeListener.certificateFile)) : undefined,
    activeFiles = new Set(
      activeListener
        ? [path.resolve(activeListener.certificateFile), path.resolve(activeListener.certificateKeyFile)]
        : [],
    );
  for (const entry of readdirSync(listenerDirectory, { withFileTypes: true })) {
    const entryPath = path.join(resolvedListenerDirectory, entry.name);
    if (entry.name.startsWith("uploaded-") && entryPath !== activeDirectory) {
      /* @gate-identity state-store/runtime-instance.authorization-configuration */ rmSync(entryPath, {
        recursive: true,
        force: true,
      });
    } else if ((entry.name === "listener.pem" || entry.name === "listener.key") && !activeFiles.has(entryPath)) {
      /* @gate-identity state-store/runtime-instance.authorization-configuration */ rmSync(entryPath, {
        force: true,
      });
    }
  }
  if (!previousListener) return;
  const selfSigned = selfSignedCertificatePaths(root),
    protectedFiles = new Set([
      ...activeFiles,
      path.resolve(selfSigned.certificateFile),
      path.resolve(selfSigned.certificateKeyFile),
    ]);
  for (const candidate of [previousListener.certificateFile, previousListener.certificateKeyFile]) {
    const resolvedCandidate = path.resolve(candidate),
      relative = path.relative(resolvedListenerDirectory, resolvedCandidate);
    if (
      relative !== "" &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative) &&
      !protectedFiles.has(resolvedCandidate) &&
      existsSyncOrSymlink(resolvedCandidate)
    ) {
      /* @gate-identity state-store/runtime-instance.authorization-configuration */ rmSync(resolvedCandidate, {
        force: true,
      });
    }
  }
}

export function removeUploadedCertificate(root: string): void {
  pruneUploadedCertificateVersions(root);
}

function existsSyncOrSymlink(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function existingCertificateIsCurrent(
  certificateFile: string,
  names: readonly string[],
  validateCertificateNames: ManagedRbacHost["validateCertificateNames"],
): boolean {
  try {
    const certificatePem = readRegularFileWithStats(certificateFile).bytes,
      certificate = new X509Certificate(certificatePem),
      now = Date.now();
    if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) return false;
    validateCertificateNames(certificatePem, names);
    return true;
  } catch (error) {
    if (error instanceof Error && (error as { readonly code?: unknown }).code === "cert_san_mismatch") return false;
    return false;
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
  if (
    listenerMaterialProblem(
      { certificateFile, certificateKeyFile, address, hostname },
      host.validateCertificateNames,
    ) === undefined &&
    existingCertificateIsCurrent(certificateFile, names, host.validateCertificateNames)
  ) {
    chmodSync(certificateKeyFile, 0o600);
    return { certificateFile, certificateKeyFile };
  }
  const temporaryCert = `${certificateFile}.tmp`,
    temporaryKey = `${certificateKeyFile}.tmp`;
  /* @gate-identity non-state/environment-io.773f1f24462e0efd */ rmSync(temporaryCert, { force: true });
  /* @gate-identity non-state/environment-io.44f16540c48fcc72 */ rmSync(temporaryKey, { force: true });
  /* @gate-identity non-state/environment-io.580e80f3650a0879 */ mkdirSync(path.dirname(certificateFile), {
    recursive: true,
    mode: 0o700,
  });
  chmodSync(path.dirname(certificateFile), 0o700);
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
      temporaryKey,
      "-out",
      temporaryCert,
      "-subj",
      `/CN=${hostname}`,
      "-days",
      "825",
      "-addext",
      `subjectAltName=${san}${addressSan}`,
    ]);
    chmodSync(temporaryKey, 0o600);
    chmodSync(temporaryCert, 0o644);
    const certBytes = readRegularFileWithStats(temporaryCert).bytes,
      keyBytes = readRegularFileWithStats(temporaryKey, { requireOwnerOnlyMode: true }).bytes;
    validateCertificateChainAndKeyPair(certBytes, keyBytes, names, host.validateCertificateNames);
    /* @gate-identity state-store/runtime-instance.authorization-configuration */ renameSync(
      temporaryCert,
      certificateFile,
    );
    /* @gate-identity state-store/runtime-instance.authorization-configuration */ renameSync(
      temporaryKey,
      certificateKeyFile,
    );
    chmodSync(certificateFile, 0o644);
    chmodSync(certificateKeyFile, 0o600);
    return { certificateFile, certificateKeyFile };
  } catch (error) {
    /* @gate-identity non-state/environment-io.778729626dd1b40c */ rmSync(temporaryCert, { force: true });
    /* @gate-identity non-state/environment-io.8f59e38af283edd1 */ rmSync(temporaryKey, { force: true });
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

export function listenerVersion(
  listener: ManagedRbacListener | undefined,
  certificateMode?: CertificateMode,
  generation?: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        listener: listener ?? null,
        certificateMode: certificateMode ?? (listener ? "domain" : "self-signed"),
        ...(listener && generation ? { generation } : {}),
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
