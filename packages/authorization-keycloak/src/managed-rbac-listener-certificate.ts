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
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { readRegularFileIfPresent } from "@harness-anything/kernel/internal/local/local-layout-file-system.ts";
import type { ManagedRbacHost } from "./managed-host.ts";

import type { CertificateMode, ManagedRbacListener, ManagedRbacRequest } from "@harness-anything/kernel";

const pemCertificateBlock = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu;
const tlsServerAuthEku = "1.3.6.1.5.5.7.3.1";
const anyExtendedKeyUsage = "2.5.29.37.0";
const basicConstraintsOid = Buffer.from([0x55, 0x1d, 0x13]); // 2.5.29.19
const domainComponentOid = "0992268993f22c640119"; // 0.9.2342.19200300.100.1.25
const directoryStringDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type ListenerMaterialProblem = "missing_certificate" | "exposed_key" | "invalid_material";
export type ListenerWriteStage = "certificate" | "key" | "config" | "cleanup";

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

function createListenerCertificateVersionPaths(
  root: string,
  prefix: "uploaded" | "self-signed",
): {
  readonly directory: string;
  readonly certificateFile: string;
  readonly certificateKeyFile: string;
  readonly generation: string;
} {
  const generation = randomBytes(12).toString("hex"),
    directory = path.join(root, "listener", `${prefix}-${generation}`);
  return {
    generation,
    directory,
    certificateFile: path.join(directory, "listener.pem"),
    certificateKeyFile: path.join(directory, "listener.key"),
  };
}

function lstatIfPresent(targetPath: string): Stats | undefined {
  return lstatSync(targetPath, { throwIfNoEntry: false });
}

function hasRealDirectory(directory: string): boolean {
  const stats = lstatIfPresent(directory);
  return Boolean(stats && !stats.isSymbolicLink() && stats.isDirectory());
}

function isContainedRealDirectory(baseDirectory: string, candidateDirectory: string): boolean {
  if (!hasRealDirectory(baseDirectory)) return false;
  const resolvedBase = path.resolve(baseDirectory),
    resolvedCandidate = path.resolve(candidateDirectory),
    relative = path.relative(resolvedBase, resolvedCandidate);
  if (relative === "") return realpathSync(resolvedBase) === realpathSync(resolvedCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  let current = resolvedBase;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!hasRealDirectory(current)) return false;
  }
  const realBase = realpathSync(resolvedBase),
    realCandidate = realpathSync(resolvedCandidate),
    realRelative = path.relative(realBase, realCandidate);
  return realRelative !== "" && !realRelative.startsWith("..") && !path.isAbsolute(realRelative);
}

function isRealManagedListenerRoot(root: string): boolean {
  const listenerDirectory = path.join(root, "listener");
  return (
    hasRealDirectory(root) &&
    hasRealDirectory(listenerDirectory) &&
    path.dirname(realpathSync(listenerDirectory)) === realpathSync(root)
  );
}

function ensureManagedListenerDirectory(root: string): string {
  const rootStats = lstatIfPresent(root);
  if (rootStats && (rootStats.isSymbolicLink() || !rootStats.isDirectory()))
    throw listenerError("Managed RBAC directory must not be a symbolic link.");
  const listenerDirectory = path.join(root, "listener"),
    listenerStats = lstatIfPresent(listenerDirectory);
  if (listenerStats && (listenerStats.isSymbolicLink() || !listenerStats.isDirectory()))
    throw listenerError("Managed listener directory must not be a symbolic link.");
  /* @gate-identity state-store/runtime-instance.authorization-configuration */ mkdirSync(listenerDirectory, {
    recursive: true,
    mode: 0o700,
  });
  if (!isRealManagedListenerRoot(root)) throw listenerError("Managed listener directory must not be a symbolic link.");
  chmodSync(listenerDirectory, 0o700);
  return listenerDirectory;
}

export function isManagedListenerPath(root: string, filePath: string): boolean {
  if (!isRealManagedListenerRoot(root)) return false;
  const listenerDirectory = path.join(root, "listener"),
    resolvedRoot = path.resolve(listenerDirectory),
    resolvedTarget = path.resolve(filePath),
    relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  if (!isContainedRealDirectory(resolvedRoot, path.dirname(resolvedTarget))) return false;
  const targetStats = lstatIfPresent(resolvedTarget);
  if (!targetStats || targetStats.isSymbolicLink() || !targetStats.isFile()) return false;
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
  const file = readRegularFileIfPresent(filePath);
  if (!file) {
    if (options.requireOwnerOnlyMode)
      throw new ListenerKeyExposedError(
        "The listener's private key must be present and readable only by its owner (chmod 600).",
      );
    throw listenerError(
      "A listener takes --hostname (as the certificate names it), --port, and absolute --certificate-file and --certificate-key-file paths. Pass none of them to serve loopback only.",
    );
  }
  if (options.requireOwnerOnlyMode && (file.mode & 0o077) !== 0)
    throw new ListenerKeyExposedError("The listener's private key must be readable only by its owner (chmod 600).");
  return file;
}

export function readRegularListenerCertificateIfPresent(filePath: string): string | undefined {
  return readRegularFileIfPresent(filePath)?.bytes.toString("utf8");
}

type DerElement = { readonly tag: number; readonly value: Buffer };

function* derElements(bytes: Buffer): Generator<DerElement> {
  let offset = 0;
  while (offset < bytes.length) {
    const tag = bytes[offset++]!,
      firstLength = bytes[offset++];
    if (firstLength === undefined) throw listenerError("The listener certificate contains malformed X.509 DER.");
    let length = firstLength;
    if (firstLength >= 0x80) {
      const width = firstLength & 0x7f;
      if (width === 0 || width > 4 || offset + width > bytes.length)
        throw listenerError("The listener certificate contains malformed X.509 DER.");
      length = bytes.readUIntBE(offset, width);
      offset += width;
    }
    const end = offset + length;
    if (end > bytes.length) throw listenerError("The listener certificate contains malformed X.509 DER.");
    yield { tag, value: bytes.subarray(offset, end) };
    offset = end;
  }
}

function certificateFields(issuer: X509Certificate): DerElement[] {
  const [certificate] = derElements(issuer.raw),
    [tbs] = derElements(certificate!.value);
  return [...derElements(tbs!.value)];
}

function issuerPathLength(fields: readonly DerElement[]): bigint | undefined {
  // Node exposes the CA flag. The optional path length is in TBSCertificate [3] Extensions.
  const extensions = fields.find(({ tag }) => tag === 0xa3);
  if (!extensions) return undefined;
  const [sequence] = derElements(extensions.value);
  for (const extension of derElements(sequence!.value)) {
    const [oid, criticalOrValue, value] = derElements(extension.value);
    if (oid?.tag !== 0x06 || !oid.value.equals(basicConstraintsOid)) continue;
    const encoded = criticalOrValue?.tag === 0x01 ? value : criticalOrValue;
    if (encoded?.tag !== 0x04) throw listenerError("The listener certificate contains malformed CA basic constraints.");
    const [constraints] = derElements(encoded.value);
    if (constraints?.tag !== 0x30)
      throw listenerError("The listener certificate contains malformed CA basic constraints.");
    // The caller checked issuer.ca. OpenSSL already decoded CA:TRUE and a nonnegative path length.
    const [, limit] = derElements(constraints.value);
    return limit ? BigInt(`0x${limit.value.toString("hex")}`) : undefined;
  }
  return undefined;
}

function caseIgnoreDirectoryString(value: string): string {
  // RFC 5280 §7.1 uses caseIgnoreMatch with RFC 4518 space handling for DirectoryString.
  const normalized = value
    .replace(/[\u0009-\u000d\u0085\p{Z}]/gu, " ")
    .replace(/[\u034f\u180b-\u180d\ufe00-\ufe0f]|[\p{Cc}\p{Cf}\u1806\ufffc]/gu, "")
    .normalize("NFKC")
    .replace(/\p{Changes_When_Casefolded}/gu, (character) =>
      /\p{Script=Cherokee}/u.test(character)
        ? character.toUpperCase()
        : character.toLowerCase().toUpperCase().toLowerCase(),
    )
    .normalize("NFKC");
  // A space immediately before a combining mark is significant.
  return normalized.replace(/(?: (?!\p{M}))+/gu, (run, offset: number) =>
    offset === 0 || offset + run.length === normalized.length ? "" : " ",
  );
}

function canonicalDistinguishedName(name: Buffer): string {
  // Preserve RDN order and sort only the attributes within each RDN.
  const relativeNames = Array.from(derElements(name), (rdn) =>
    Array.from(derElements(rdn.value), ({ value }) => {
      const [oid, attribute] = derElements(value),
        type = oid!.value.toString("hex");
      if (attribute!.tag === 0x0c || attribute!.tag === 0x13) {
        const text = directoryStringDecoder.decode(attribute!.value);
        return `${type}:text:${caseIgnoreDirectoryString(text)}`;
      }
      if (attribute!.tag === 0x16 && type === domainComponentOid)
        return `${type}:domain:${attribute!.value.toString("latin1").toLowerCase()}`;
      return `${type}:${attribute!.tag}:${attribute!.value.toString("hex")}`;
    }).sort(),
  );
  return JSON.stringify(relativeNames);
}

export function validateCertificateChainAndKeyPair(
  certificateBytes: Buffer,
  keyBytes: Buffer,
  names?: readonly string[],
  validateCertificateNames?: ManagedRbacHost["validateCertificateNames"],
  now = Date.now(),
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
  for (const certificate of certificates) {
    const validFrom = certificate.validFromDate.getTime(),
      validTo = certificate.validToDate.getTime();
    if (!Number.isFinite(validFrom) || !Number.isFinite(validTo) || validFrom > now || validTo <= now)
      throw listenerError("The listener certificate chain contains an expired or not-yet-valid certificate.");
  }
  const leaf = certificates[0]!;
  if (
    leaf.keyUsage &&
    leaf.keyUsage.length > 0 &&
    !leaf.keyUsage.includes(tlsServerAuthEku) &&
    !leaf.keyUsage.includes(anyExtendedKeyUsage)
  )
    throw listenerError("The listener certificate extended key usage does not permit TLS server authentication.");
  if (certificates.length === 1 && leaf.checkIssued(leaf) && !leaf.verify(leaf.publicKey))
    throw listenerError("The self-signed listener certificate signature is invalid.");
  let intermediateDepth = 0;
  for (let index = 1; index < certificates.length; index += 1) {
    const child = certificates[index - 1]!,
      issuer = certificates[index]!;
    if (!issuer.ca)
      throw listenerError("The listener certificate chain contains an issuer without CA basic constraints.");
    if (!child.checkIssued(issuer) || !child.verify(issuer.publicKey))
      throw listenerError("The listener certificate chain is invalid or out of order.");
    const fields = certificateFields(issuer),
      pathLength = issuerPathLength(fields);
    if (pathLength !== undefined && intermediateDepth > pathLength)
      throw listenerError("The listener certificate chain exceeds a CA path length constraint.");
    if (index + 1 < certificates.length) {
      const versionOffset = fields[0]?.tag === 0xa0 ? 1 : 0,
        issuerName = fields[versionOffset + 2]!.value,
        subjectName = fields[versionOffset + 4]!.value;
      if (
        !issuerName.equals(subjectName) &&
        canonicalDistinguishedName(issuerName) !== canonicalDistinguishedName(subjectName)
      )
        intermediateDepth += 1;
    }
  }
  if (names && validateCertificateNames) validateCertificateNames(certificateBytes, names);
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(keyBytes);
  } catch {
    throw listenerError("The listener private key must be a valid unencrypted PEM private key.");
  }
  const certPublicKey = leaf.publicKey.export({ type: "spki", format: "der" }),
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

function writeManagedFileAtomically(file: string, content: Buffer, mode: number): void {
  const temporary = `${file}.tmp`;
  /* @gate-identity state-store/runtime-instance.authorization-configuration */ writeFileSync(temporary, content, {
    mode,
  });
  chmodSync(temporary, mode);
  /* @gate-identity state-store/runtime-instance.authorization-configuration */ renameSync(temporary, file);
}

export function installUploadedCertificate(
  root: string,
  sourceCertificateFile: string,
  sourceKeyFile: string,
  names: readonly string[],
  validateCertificateNames: ManagedRbacHost["validateCertificateNames"],
  onWriteStage?: (stage: ListenerWriteStage) => void,
): { readonly certificateFile: string; readonly certificateKeyFile: string; readonly generation: string } {
  const certificateBytes = readRegularFileWithStats(sourceCertificateFile).bytes,
    keyBytes = readRegularFileWithStats(sourceKeyFile, { requireOwnerOnlyMode: true }).bytes;
  validateCertificateChainAndKeyPair(certificateBytes, keyBytes, names, validateCertificateNames);
  ensureManagedListenerDirectory(root);
  const { directory, certificateFile, certificateKeyFile, generation } = createListenerCertificateVersionPaths(
    root,
    "uploaded",
  );
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

function protectReferencedPath(filePath: string, protectedPaths: Set<string>): void {
  const separator = process.platform === "win32" ? /[\\/]+/u : /\/+/u,
    pending: string[] = [];
  let directory = process.cwd(),
    links = 0;
  const expand = (target: string): void => {
    const { root } = path.parse(target);
    if (root) directory = path.resolve(directory, root);
    for (const segment of target.slice(root.length).split(separator).reverse()) {
      if (segment) pending.push(segment);
    }
  };
  expand(filePath);
  while (pending.length > 0) {
    const entry = path.join(directory, pending.pop()!);
    protectedPaths.add(entry);
    const stats = lstatIfPresent(entry);
    if (!stats) return;
    if (stats.isSymbolicLink()) {
      if (++links > 64)
        throw new Error("A listener certificate reference has too many symbolic links to prune safely.");
      // Keep entries along the link target as well as the final file. Resolve '..' after following each link.
      expand(readlinkSync(entry));
      continue;
    }
    const real = realpathSync.native(entry);
    protectedPaths.add(real);
    if (!stats.isDirectory()) return;
    directory = real;
  }
}

function removeSelfSignedCertificate(root: string, protectedPaths: ReadonlySet<string>): void {
  const { certificateFile, certificateKeyFile } = selfSignedCertificatePaths(root),
    listenerDirectory = path.join(root, "listener");
  if (!isRealManagedListenerRoot(root)) return;
  const realListenerDirectory = realpathSync.native(listenerDirectory);
  for (const [index, target] of [certificateFile, certificateKeyFile].entries()) {
    const resolved = path.resolve(target),
      stats = lstatIfPresent(resolved);
    if (!stats || protectedPaths.has(path.join(realListenerDirectory, path.basename(resolved)))) continue;
    if (!stats.isSymbolicLink() && stats.isFile()) {
      const real = realpathSync.native(resolved);
      if (path.dirname(real) !== realListenerDirectory || protectedPaths.has(real)) continue;
    } else if (!stats.isSymbolicLink()) continue;
    if (index === 0) /* @gate-identity non-state/environment-io.0437be7bf65098b0 */ rmSync(resolved, { force: true });
    else /* @gate-identity non-state/environment-io.64dd2033f7d1c003 */ rmSync(resolved, { force: true });
  }
}

export function pruneListenerCertificateVersions(
  root: string,
  activeListener?: Pick<ManagedRbacListener, "certificateFile" | "certificateKeyFile">,
  previousListener?: Pick<ManagedRbacListener, "certificateFile" | "certificateKeyFile">,
  protectedExternalPaths: readonly string[] = [],
  onWriteStage?: (stage: ListenerWriteStage) => void,
): void {
  if (!isRealManagedListenerRoot(root)) return;
  const listenerDirectory = path.join(root, "listener"),
    realListenerDirectory = realpathSync.native(listenerDirectory),
    protectedPaths = new Set<string>();
  // Keep the active generation even when the persisted paths use an aliased userRoot.
  if (activeListener) {
    protectReferencedPath(activeListener.certificateFile, protectedPaths);
    protectReferencedPath(activeListener.certificateKeyFile, protectedPaths);
  }
  for (const filePath of new Set(protectedExternalPaths)) protectReferencedPath(filePath, protectedPaths);
  onWriteStage?.("cleanup");
  for (const entry of readdirSync(listenerDirectory, { withFileTypes: true })) {
    const entryPath = path.join(listenerDirectory, entry.name);
    if (entry.name.startsWith("uploaded-") || entry.name.startsWith("self-signed-")) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const realEntry = realpathSync.native(entryPath);
      if (path.dirname(realEntry) !== realListenerDirectory || protectedPaths.has(realEntry)) continue;
      /* @gate-identity state-store/runtime-instance.authorization-configuration */ rmSync(entryPath, {
        recursive: true,
        force: true,
      });
    } else if (entry.name === "listener.pem" || entry.name === "listener.key") {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const realEntry = realpathSync.native(entryPath);
      if (path.dirname(realEntry) !== realListenerDirectory || protectedPaths.has(realEntry)) continue;
      /* @gate-identity state-store/runtime-instance.authorization-configuration */ rmSync(entryPath, {
        force: true,
      });
    }
  }
  removeSelfSignedCertificate(root, protectedPaths);
  if (!previousListener) return;
  for (const candidate of [previousListener.certificateFile, previousListener.certificateKeyFile]) {
    const resolvedCandidate = path.resolve(candidate),
      parentDirectory = path.dirname(resolvedCandidate);
    if (!isContainedRealDirectory(listenerDirectory, parentDirectory)) continue;
    const stats = lstatIfPresent(resolvedCandidate);
    if (!stats || protectedPaths.has(path.join(realpathSync.native(parentDirectory), path.basename(resolvedCandidate))))
      continue;
    if (stats.isSymbolicLink()) {
      /* @gate-identity state-store/runtime-instance.authorization-configuration */ rmSync(resolvedCandidate, {
        force: true,
      });
      continue;
    }
    if (!stats.isFile()) continue;
    const realCandidate = realpathSync.native(resolvedCandidate),
      realRelative = path.relative(realListenerDirectory, realCandidate);
    if (
      realRelative !== "" &&
      !realRelative.startsWith("..") &&
      !path.isAbsolute(realRelative) &&
      !protectedPaths.has(realCandidate)
    ) {
      /* @gate-identity state-store/runtime-instance.authorization-configuration */ rmSync(resolvedCandidate, {
        force: true,
      });
    }
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
  existing?: {
    readonly listener?: Pick<ManagedRbacListener, "certificateFile" | "certificateKeyFile">;
    readonly generation?: string;
    readonly certificateMode?: CertificateMode;
  },
  onWriteStage?: (stage: ListenerWriteStage) => void,
): Promise<{
  readonly certificateFile: string;
  readonly certificateKeyFile: string;
  readonly generation?: string;
  readonly stagedDirectory?: string;
}> {
  if (
    existing?.certificateMode === "self-signed" &&
    existing.listener &&
    isManagedListenerPair(root, existing.listener) &&
    listenerMaterialProblem({ ...existing.listener, address, hostname }, host.validateCertificateNames) === undefined
  ) {
    chmodSync(existing.listener.certificateKeyFile, 0o600);
    return {
      certificateFile: existing.listener.certificateFile,
      certificateKeyFile: existing.listener.certificateKeyFile,
      ...(existing.generation ? { generation: existing.generation } : {}),
    };
  }
  ensureManagedListenerDirectory(root);
  const { directory, certificateFile, certificateKeyFile, generation } = createListenerCertificateVersionPaths(
      root,
      "self-signed",
    ),
    temporaryCert = `${certificateFile}.tmp`,
    temporaryKey = `${certificateKeyFile}.tmp`,
    names = [address, hostname];
  /* @gate-identity non-state/environment-io.580e80f3650a0879 */ mkdirSync(path.dirname(certificateFile), {
    recursive: true,
    mode: 0o700,
  });
  chmodSync(directory, 0o700);
  /* @gate-identity non-state/environment-io.773f1f24462e0efd */ rmSync(temporaryCert, { force: true });
  /* @gate-identity non-state/environment-io.44f16540c48fcc72 */ rmSync(temporaryKey, { force: true });
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
    onWriteStage?.("certificate");
    /* @gate-identity state-store/runtime-instance.authorization-configuration */ renameSync(
      temporaryCert,
      certificateFile,
    );
    onWriteStage?.("key");
    /* @gate-identity state-store/runtime-instance.authorization-configuration */ renameSync(
      temporaryKey,
      certificateKeyFile,
    );
    return { certificateFile, certificateKeyFile, generation, stagedDirectory: directory };
  } catch (error) {
    /* @gate-identity non-state/environment-io.778729626dd1b40c */ rmSync(temporaryCert, { force: true });
    /* @gate-identity non-state/environment-io.8f59e38af283edd1 */ rmSync(temporaryKey, { force: true });
    /* @gate-identity state-store/runtime-instance.authorization-configuration */ rmSync(directory, {
      recursive: true,
      force: true,
    });
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
