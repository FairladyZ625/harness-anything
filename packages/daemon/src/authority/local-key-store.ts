import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  type KeyObject
} from "node:crypto";
import path from "node:path";
import {
  assertAuthorityKeyRegistryV1,
  authorityKeyId,
  authoritySigningPurpose,
  createAuthorityKeyRegistryResolverV1,
  type ActorAxesProofKeyResolverV2,
  type ActorAxesSigningProfileV2,
  type AuthorityKeyRegistryEntryV1,
  type AuthorityKeyRegistryV1
} from "../../../application/src/index.ts";
import { isMissing } from "../broker/errno.ts";

const localAuthorityKeyCacheSchema = "authority-key-material-cache/v1" as const;
const privateKeyFilePattern = /^ed25519:sha256:([0-9a-f]{64})$/u;
const noFollowFlag = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

interface LocalAuthorityKeyCacheEntry {
  readonly keyId: string;
  readonly publicKeySpki: string;
}

interface LocalAuthorityKeyCache {
  readonly schema: typeof localAuthorityKeyCacheSchema;
  readonly authorityId: string;
  readonly issuer: string;
  readonly keys: ReadonlyArray<LocalAuthorityKeyCacheEntry>;
}

export interface LocalAuthorityKeyStoreOptions {
  /** Dedicated service-state root. It must be outside the repository and every forbidden root. */
  readonly serviceStateRoot: string;
  /** Store directory beneath serviceStateRoot. */
  readonly stateDirectory: string;
  readonly workspaceRoot: string;
  readonly authorityId: string;
  readonly issuer: string;
  /** Include repository, harness, CAS, and backup roots that must never contain private material. */
  readonly forbiddenRoots?: ReadonlyArray<string>;
  readonly expectedUid?: number;
}

export interface CreatePrepublishedAuthorityKeyInput {
  readonly generation: number;
  readonly nowMs: number;
  readonly predecessorKeyId?: string;
  readonly predecessorProof?: string;
}

export interface LocalAuthorityKeyStore {
  readonly stateDirectory: string;
  readonly keyIds: () => ReadonlyArray<string>;
  /** Rebuilds the public cache from secure private material, gated by the canonical registry. */
  readonly recoverPublicCache: (canonicalRegistry: AuthorityKeyRegistryV1) => ReadonlyArray<string>;
  readonly createPrepublishedKey: (input: CreatePrepublishedAuthorityKeyInput) => AuthorityKeyRegistryEntryV1;
  readonly signingProfile: (canonicalRegistry: AuthorityKeyRegistryV1, nowMs: number) => ActorAxesSigningProfileV2;
  readonly proofKeyResolver: (canonicalRegistry: AuthorityKeyRegistryV1, nowMs: number) => ActorAxesProofKeyResolverV2;
  readonly destroyPrivateKey: (keyId: string) => void;
}

/**
 * Opens a local Ed25519 material store. The public cache is reconstructable
 * service state; the caller-supplied canonical registry remains the only
 * lifecycle authority and no signing key is created implicitly.
 */
export function openLocalAuthorityKeyStore(options: LocalAuthorityKeyStoreOptions): LocalAuthorityKeyStore {
  const authorityId = requiredKeyStoreText(options.authorityId, "authorityId");
  const issuer = requiredKeyStoreText(options.issuer, "issuer");
  const expectedUid = options.expectedUid ?? process.getuid?.() ?? 0;
  const serviceStateRoot = path.resolve(options.serviceStateRoot);
  const stateDirectory = path.resolve(options.stateDirectory);
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const forbiddenRoots = [workspaceRoot, ...(options.forbiddenRoots ?? []).map((root) => path.resolve(root))];

  if (!isDescendant(stateDirectory, serviceStateRoot)) {
    throw new Error("AUTHORITY_KEY_STORE_STATE_OUTSIDE_SERVICE_ROOT");
  }
  for (const forbiddenRoot of forbiddenRoots) {
    if (pathsOverlap(serviceStateRoot, forbiddenRoot)) {
      throw new Error(`AUTHORITY_KEY_STORE_FORBIDDEN_ROOT:${forbiddenRoot}`);
    }
  }

  ensurePrivateDirectory(serviceStateRoot, expectedUid, true);
  ensurePrivateDirectoryTree(serviceStateRoot, stateDirectory, expectedUid);
  const privateKeyDirectory = path.join(stateDirectory, "private-keys");
  ensurePrivateDirectory(privateKeyDirectory, expectedUid, true);

  const realServiceRoot = realpathSync(serviceStateRoot);
  const realStateDirectory = realpathSync(stateDirectory);
  if (!isDescendant(realStateDirectory, realServiceRoot)) {
    throw new Error("AUTHORITY_KEY_STORE_STATE_SYMLINK_ESCAPE");
  }
  for (const forbiddenRoot of forbiddenRoots) {
    const comparableForbiddenRoot = realpathIfPresent(forbiddenRoot);
    if (pathsOverlap(realServiceRoot, comparableForbiddenRoot)) {
      throw new Error(`AUTHORITY_KEY_STORE_FORBIDDEN_ROOT:${forbiddenRoot}`);
    }
  }

  const cachePath = path.join(stateDirectory, "authority-public-key-cache.json");
  let cache = loadCache(cachePath, authorityId, issuer, expectedUid);

  const privateKeyPath = (keyId: string): string => {
    const match = privateKeyFilePattern.exec(keyId);
    if (!match) throw new Error("AUTHORITY_KEY_STORE_KEY_ID_INVALID");
    return path.join(privateKeyDirectory, `${match[1]}.pk8`);
  };

  const persistCache = (nextKeys: ReadonlyArray<LocalAuthorityKeyCacheEntry>): void => {
    const nextCache: LocalAuthorityKeyCache = {
      schema: localAuthorityKeyCacheSchema,
      authorityId,
      issuer,
      keys: [...nextKeys].sort((left, right) => left.keyId.localeCompare(right.keyId))
    };
    writeCache(cachePath, nextCache, expectedUid);
    cache = nextCache;
  };

  return {
    stateDirectory,
    keyIds: () => cache.keys
      .filter((entry) => secureFileExists(privateKeyPath(entry.keyId), expectedUid))
      .map((entry) => entry.keyId),
    recoverPublicCache: (canonicalRegistry) => {
      assertRegistryScope(canonicalRegistry, authorityId);
      const recovered: LocalAuthorityKeyCacheEntry[] = [];
      for (const entry of canonicalRegistry.entries) {
        if (entry.authorityId !== authorityId || entry.issuer !== issuer
          || entry.algorithm !== "Ed25519" || entry.purpose !== authoritySigningPurpose) continue;
        const destination = privateKeyPath(entry.keyId);
        if (!secureFileExists(destination, expectedUid)) continue;
        const privateKey = readPrivateKey(destination, expectedUid);
        const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
        const publicKeySpki = publicDer.toString("base64url");
        if (authorityKeyId(publicDer) !== entry.keyId || publicKeySpki !== entry.publicKeySpki) {
          throw new Error("AUTHORITY_KEY_STORE_RECOVERY_REGISTRY_MISMATCH");
        }
        recovered.push({ keyId: entry.keyId, publicKeySpki });
      }
      persistCache(recovered);
      return recovered.map((entry) => entry.keyId).sort();
    },
    createPrepublishedKey: (input) => {
      positiveKeyStoreInteger(input.generation, "generation");
      nonNegativeKeyStoreInteger(input.nowMs, "nowMs");
      const predecessorKeyId = input.predecessorKeyId ?? null;
      const predecessorProof = input.predecessorProof ?? null;
      if ((predecessorKeyId === null) !== (predecessorProof === null)) {
        throw new Error("AUTHORITY_KEY_STORE_PREDECESSOR_PAIR_INCOMPLETE");
      }
      if (predecessorKeyId !== null) requiredKeyStoreText(predecessorKeyId, "predecessorKeyId");
      if (predecessorProof !== null) requiredKeyStoreText(predecessorProof, "predecessorProof");

      const generated = generateKeyPairSync("ed25519");
      const publicDer = generated.publicKey.export({ format: "der", type: "spki" });
      const publicKeySpki = publicDer.toString("base64url");
      const keyId = authorityKeyId(generated.publicKey);
      const destination = privateKeyPath(keyId);
      writePrivateKeyExclusive(
        destination,
        generated.privateKey.export({ format: "der", type: "pkcs8" }),
        expectedUid
      );
      try {
        persistCache([...cache.keys.filter((entry) => entry.keyId !== keyId), { keyId, publicKeySpki }]);
      } catch (error) {
        unlinkSync(destination);
        syncKeyMaterialDirectory(privateKeyDirectory);
        throw error;
      }
      return {
        authorityId,
        issuer,
        algorithm: "Ed25519",
        keyId,
        purpose: authoritySigningPurpose,
        publicKeySpki,
        state: "PREPUBLISHED",
        generation: input.generation,
        notBeforeMs: input.nowMs,
        notAfterMs: null,
        verifyUntilMs: null,
        predecessorKeyId,
        predecessorProof,
        activationEvidence: null
      };
    },
    signingProfile: (canonicalRegistry, nowMs) => {
      assertRegistryScope(canonicalRegistry, authorityId);
      nonNegativeKeyStoreInteger(nowMs, "nowMs");
      const candidates = canonicalRegistry.entries.filter((entry) =>
        entry.authorityId === authorityId
        && entry.issuer === issuer
        && entry.generation === canonicalRegistry.generation
        && entry.purpose === authoritySigningPurpose
        && entry.state === "ACTIVE_SIGNING"
        && nowMs >= entry.notBeforeMs
        && (entry.notAfterMs === null || nowMs <= entry.notAfterMs)
      );
      if (candidates.length !== 1) throw new Error("AUTHORITY_KEY_STORE_ACTIVE_SIGNER_REQUIRED");
      const entry = candidates[0]!;
      const privateKey = readPrivateKey(privateKeyPath(entry.keyId), expectedUid);
      const derivedPublicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
      if (authorityKeyId(derivedPublicDer) !== entry.keyId
        || derivedPublicDer.toString("base64url") !== entry.publicKeySpki) {
        throw new Error("AUTHORITY_KEY_STORE_PRIVATE_PUBLIC_MISMATCH");
      }
      return { algorithm: "Ed25519", issuer, keyId: entry.keyId, privateKey };
    },
    proofKeyResolver: (canonicalRegistry, nowMs) => {
      assertRegistryScope(canonicalRegistry, authorityId);
      nonNegativeKeyStoreInteger(nowMs, "nowMs");
      return createAuthorityKeyRegistryResolverV1({
        registry: canonicalRegistry,
        authorityId,
        issuer,
        purpose: authoritySigningPurpose,
        generation: canonicalRegistry.generation,
        nowMs: () => nowMs
      });
    },
    destroyPrivateKey: (keyId) => {
      const destination = privateKeyPath(keyId);
      assertSecureRegularFile(destination, expectedUid);
      unlinkSync(destination);
      syncKeyMaterialDirectory(privateKeyDirectory);
      persistCache(cache.keys.filter((entry) => entry.keyId !== keyId));
    }
  };
}

function assertRegistryScope(registry: AuthorityKeyRegistryV1, authorityId: string): void {
  assertAuthorityKeyRegistryV1(registry);
  if (registry.authorityId !== authorityId) throw new Error("AUTHORITY_KEY_STORE_REGISTRY_SCOPE_MISMATCH");
}

function ensurePrivateDirectoryTree(root: string, destination: string, expectedUid: number): void {
  const relative = path.relative(root, destination);
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    ensurePrivateDirectory(cursor, expectedUid, true);
  }
}

function ensurePrivateDirectory(directory: string, expectedUid: number, create: boolean): void {
  if (create) {
    try {
      mkdirSync(directory, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (!isKeyStoreAlreadyExists(error)) throw error;
    }
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o777) !== 0o700) {
    throw new Error(`AUTHORITY_KEY_STORE_DIRECTORY_UNSAFE:${directory}`);
  }
}

function loadCache(cachePath: string, authorityId: string, issuer: string, expectedUid: number): LocalAuthorityKeyCache {
  let bytes: Buffer;
  try {
    bytes = readSecureFile(cachePath, expectedUid);
  } catch (error) {
    if (isMissing(error)) return { schema: localAuthorityKeyCacheSchema, authorityId, issuer, keys: [] };
    throw error;
  }
  const value = JSON.parse(bytes.toString("utf8")) as Partial<LocalAuthorityKeyCache>;
  if (value.schema !== localAuthorityKeyCacheSchema || value.authorityId !== authorityId
    || value.issuer !== issuer || !Array.isArray(value.keys)) {
    throw new Error("AUTHORITY_KEY_STORE_CACHE_INVALID");
  }
  const keys = value.keys.map((entry) => validateCacheEntry(entry));
  if (new Set(keys.map((entry) => entry.keyId)).size !== keys.length) {
    throw new Error("AUTHORITY_KEY_STORE_CACHE_DUPLICATE");
  }
  return { schema: localAuthorityKeyCacheSchema, authorityId, issuer, keys };
}

function validateCacheEntry(value: unknown): LocalAuthorityKeyCacheEntry {
  if (typeof value !== "object" || value === null) throw new Error("AUTHORITY_KEY_STORE_CACHE_INVALID");
  const entry = value as Partial<LocalAuthorityKeyCacheEntry>;
  if (typeof entry.keyId !== "string" || typeof entry.publicKeySpki !== "string"
    || !privateKeyFilePattern.test(entry.keyId)) throw new Error("AUTHORITY_KEY_STORE_CACHE_INVALID");
  const publicDer = Buffer.from(entry.publicKeySpki, "base64url");
  if (publicDer.toString("base64url") !== entry.publicKeySpki || authorityKeyId(publicDer) !== entry.keyId
    || createPublicKey({ key: publicDer, format: "der", type: "spki" }).asymmetricKeyType !== "ed25519") {
    throw new Error("AUTHORITY_KEY_STORE_CACHE_INVALID");
  }
  return { keyId: entry.keyId, publicKeySpki: entry.publicKeySpki };
}

function writeCache(cachePath: string, cache: LocalAuthorityKeyCache, expectedUid: number): void {
  rejectSymlinkOrUnsafeExistingFile(cachePath, expectedUid);
  const temporary = path.join(path.dirname(cachePath), `.${path.basename(cachePath)}.${randomUUID()}.tmp`);
  try {
    writePrivateKeyExclusive(temporary, Buffer.from(`${JSON.stringify(cache)}\n`, "utf8"), expectedUid);
    renameSync(temporary, cachePath);
    syncKeyMaterialDirectory(path.dirname(cachePath));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function writePrivateKeyExclusive(destination: string, bytes: Uint8Array, expectedUid: number): void {
  const descriptor = openSync(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag,
    0o600
  );
  try {
    assertSecureDescriptor(descriptor, destination, expectedUid);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  syncKeyMaterialDirectory(path.dirname(destination));
}

function readPrivateKey(destination: string, expectedUid: number): KeyObject {
  const key = createPrivateKey({ key: readSecureFile(destination, expectedUid), format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("AUTHORITY_KEY_STORE_KEY_TYPE_UNSUPPORTED");
  return key;
}

function readSecureFile(destination: string, expectedUid: number): Buffer {
  const descriptor = openSync(destination, constants.O_RDONLY | noFollowFlag);
  try {
    assertSecureDescriptor(descriptor, destination, expectedUid);
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function assertSecureRegularFile(destination: string, expectedUid: number): void {
  const descriptor = openSync(destination, constants.O_RDONLY | noFollowFlag);
  try {
    assertSecureDescriptor(descriptor, destination, expectedUid);
  } finally {
    closeSync(descriptor);
  }
}

function assertSecureDescriptor(descriptor: number, destination: string, expectedUid: number): void {
  const stat = fstatSync(descriptor);
  if (!stat.isFile() || stat.uid !== expectedUid || (stat.mode & 0o777) !== 0o600) {
    throw new Error(`AUTHORITY_KEY_STORE_FILE_UNSAFE:${destination}`);
  }
}

function rejectSymlinkOrUnsafeExistingFile(destination: string, expectedUid: number): void {
  try {
    const stat = lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o777) !== 0o600) {
      throw new Error(`AUTHORITY_KEY_STORE_FILE_UNSAFE:${destination}`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function secureFileExists(destination: string, expectedUid: number): boolean {
  try {
    assertSecureRegularFile(destination, expectedUid);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function syncKeyMaterialDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, constants.O_RDONLY | noFollowFlag);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function realpathIfPresent(value: string): string {
  try {
    return realpathSync(value);
  } catch (error) {
    if (isMissing(error)) return path.resolve(value);
    throw error;
  }
}

function isKeyStoreAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function isDescendant(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function pathsOverlap(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right)
    || isDescendant(path.resolve(left), path.resolve(right))
    || isDescendant(path.resolve(right), path.resolve(left));
}

function requiredKeyStoreText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`AUTHORITY_KEY_STORE_FIELD_INVALID:${label}`);
  return value;
}

function positiveKeyStoreInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`AUTHORITY_KEY_STORE_FIELD_INVALID:${label}`);
  return value;
}

function nonNegativeKeyStoreInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`AUTHORITY_KEY_STORE_FIELD_INVALID:${label}`);
  return value;
}
