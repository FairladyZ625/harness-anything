import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import type {
  ActorAxesProofKeyResolverV2,
  BindingProofHeaderV2
} from "./actor-axes-binding-v2.ts";

export const authorityKeyRegistrySchema = "authority-key-registry/v1" as const;
export const authoritySigningPurpose = "authority-signing/v1" as const;
export const authorityTokenTtlMs = 5 * 60 * 1_000;
export const authorityClockSkewMs = 30 * 1_000;

export type AuthorityKeyLifecycleState =
  | "PREPUBLISHED"
  | "ACTIVE_SIGNING"
  | "VERIFY_ONLY"
  | "REVOKED";

export interface AuthorityKeyRegistryEntryV1 {
  readonly authorityId: string;
  readonly issuer: string;
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly purpose: typeof authoritySigningPurpose;
  readonly publicKeySpki: string;
  readonly state: AuthorityKeyLifecycleState;
  readonly generation: number;
  readonly notBeforeMs: number;
  readonly notAfterMs: number | null;
  readonly verifyUntilMs: number | null;
  readonly predecessorKeyId: string | null;
  readonly predecessorProof: string | null;
}

export interface AuthorityKeyRegistryV1 {
  readonly schema: typeof authorityKeyRegistrySchema;
  readonly authorityId: string;
  readonly generation: number;
  readonly globalRevocationEpoch: number;
  readonly revision: number;
  readonly entries: ReadonlyArray<AuthorityKeyRegistryEntryV1>;
  readonly manifestDigest: string;
}

export function authorityKeyId(publicKey: KeyObject | Uint8Array): string {
  const der = publicKey instanceof Uint8Array
    ? Buffer.from(publicKey)
    : publicKey.export({ format: "der", type: "spki" });
  return `ed25519:sha256:${createHash("sha256").update(der).digest("hex")}`;
}

export function createAuthorityKeyRegistryV1(
  input: Omit<AuthorityKeyRegistryV1, "schema" | "manifestDigest">
): AuthorityKeyRegistryV1 {
  const core = {
    schema: authorityKeyRegistrySchema,
    authorityId: requiredText(input.authorityId, "authorityId"),
    generation: positiveInteger(input.generation, "generation"),
    globalRevocationEpoch: positiveInteger(input.globalRevocationEpoch, "globalRevocationEpoch"),
    revision: positiveInteger(input.revision, "revision"),
    entries: [...input.entries].sort(compareEntries).map(validateEntry)
  };
  const registry = {
    ...core,
    manifestDigest: manifestDigest(core)
  } satisfies AuthorityKeyRegistryV1;
  assertAuthorityKeyRegistryV1(registry);
  return registry;
}

export function assertAuthorityKeyRegistryV1(value: AuthorityKeyRegistryV1): void {
  if (value.schema !== authorityKeyRegistrySchema) throw new Error("AUTHORITY_KEY_REGISTRY_SCHEMA_UNSUPPORTED");
  requiredText(value.authorityId, "authorityId");
  positiveInteger(value.generation, "generation");
  positiveInteger(value.globalRevocationEpoch, "globalRevocationEpoch");
  positiveInteger(value.revision, "revision");
  const entries = [...value.entries].sort(compareEntries).map(validateEntry);
  if (JSON.stringify(entries) !== JSON.stringify(value.entries)) {
    throw new Error("AUTHORITY_KEY_REGISTRY_ENTRIES_NOT_CANONICAL");
  }
  const expected = manifestDigest({
    schema: value.schema,
    authorityId: value.authorityId,
    generation: value.generation,
    globalRevocationEpoch: value.globalRevocationEpoch,
    revision: value.revision,
    entries
  });
  if (value.manifestDigest !== expected) throw new Error("AUTHORITY_KEY_REGISTRY_MANIFEST_DIGEST_MISMATCH");
  const tuples = new Set<string>();
  let activeForGeneration = 0;
  for (const entry of entries) {
    if (entry.authorityId !== value.authorityId) throw new Error("AUTHORITY_KEY_REGISTRY_SCOPE_MISMATCH");
    const tuple = `${entry.authorityId}\0${entry.issuer}\0${entry.algorithm}\0${entry.keyId}\0${entry.purpose}\0${entry.generation}`;
    if (tuples.has(tuple)) throw new Error("AUTHORITY_KEY_REGISTRY_EXACT_TUPLE_DUPLICATE");
    tuples.add(tuple);
    if (entry.generation === value.generation && entry.state === "ACTIVE_SIGNING") activeForGeneration += 1;
  }
  if (activeForGeneration > 1) throw new Error("AUTHORITY_KEY_REGISTRY_MULTIPLE_ACTIVE_SIGNERS");
}

export function createAuthorityKeyRegistryResolverV1(input: {
  readonly registry: AuthorityKeyRegistryV1;
  readonly authorityId: string;
  readonly issuer: string;
  readonly purpose: typeof authoritySigningPurpose;
  readonly generation: number;
  readonly nowMs: () => number;
}): ActorAxesProofKeyResolverV2 {
  assertAuthorityKeyRegistryV1(input.registry);
  return {
    resolve: (header) => resolveExactEntry(input, header)
  };
}

export function authorityKeyRegistryEntryDigest(entry: AuthorityKeyRegistryEntryV1): Uint8Array {
  const validated = validateEntry(entry);
  return createHash("sha256").update(canonicalJson({ ...validated, predecessorProof: null }), "utf8").digest();
}

function resolveExactEntry(
  input: {
    readonly registry: AuthorityKeyRegistryV1;
    readonly authorityId: string;
    readonly issuer: string;
    readonly purpose: typeof authoritySigningPurpose;
    readonly generation: number;
    readonly nowMs: () => number;
  },
  header: BindingProofHeaderV2
): { readonly algorithm: "Ed25519"; readonly publicKey: KeyObject } | undefined {
  if (header.algorithm !== "Ed25519"
    || header.issuer !== input.issuer
    || input.registry.authorityId !== input.authorityId
    || input.registry.generation !== input.generation) return undefined;
  const entry = input.registry.entries.find((candidate) =>
    candidate.authorityId === input.authorityId
    && candidate.issuer === input.issuer
    && candidate.algorithm === header.algorithm
    && candidate.keyId === header.keyId
    && candidate.purpose === input.purpose
    && candidate.generation === input.generation
  );
  if (!entry || (entry.state !== "ACTIVE_SIGNING" && entry.state !== "VERIFY_ONLY")) return undefined;
  const now = input.nowMs();
  if (now < entry.notBeforeMs) return undefined;
  if (entry.state === "ACTIVE_SIGNING" && entry.notAfterMs !== null && now > entry.notAfterMs) return undefined;
  if (entry.state === "VERIFY_ONLY" && (entry.verifyUntilMs === null || now > entry.verifyUntilMs)) return undefined;
  const der = Buffer.from(entry.publicKeySpki, "base64url");
  if (authorityKeyId(der) !== entry.keyId) return undefined;
  const publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ed25519") return undefined;
  return { algorithm: "Ed25519", publicKey };
}

function validateEntry(entry: AuthorityKeyRegistryEntryV1): AuthorityKeyRegistryEntryV1 {
  requiredText(entry.authorityId, "entry.authorityId");
  requiredText(entry.issuer, "entry.issuer");
  requiredText(entry.keyId, "entry.keyId");
  if (entry.algorithm !== "Ed25519") throw new Error("AUTHORITY_KEY_REGISTRY_ALGORITHM_UNSUPPORTED");
  if (entry.purpose !== authoritySigningPurpose) throw new Error("AUTHORITY_KEY_REGISTRY_PURPOSE_UNSUPPORTED");
  if (!["PREPUBLISHED", "ACTIVE_SIGNING", "VERIFY_ONLY", "REVOKED"].includes(entry.state)) {
    throw new Error("AUTHORITY_KEY_REGISTRY_STATE_UNSUPPORTED");
  }
  positiveInteger(entry.generation, "entry.generation");
  nonNegativeAuthorityInteger(entry.notBeforeMs, "entry.notBeforeMs");
  nullableNonNegativeInteger(entry.notAfterMs, "entry.notAfterMs");
  nullableNonNegativeInteger(entry.verifyUntilMs, "entry.verifyUntilMs");
  if (entry.state === "VERIFY_ONLY" && entry.verifyUntilMs === null) {
    throw new Error("AUTHORITY_KEY_VERIFY_ONLY_REQUIRES_CUTOFF");
  }
  if (entry.state !== "VERIFY_ONLY" && entry.verifyUntilMs !== null) {
    throw new Error("AUTHORITY_KEY_VERIFY_CUTOFF_STATE_MISMATCH");
  }
  if (entry.state !== "PREPUBLISHED" && entry.predecessorProof === null && entry.predecessorKeyId !== null) {
    throw new Error("AUTHORITY_KEY_PREDECESSOR_PROOF_MISSING");
  }
  if (entry.notAfterMs !== null && entry.notAfterMs < entry.notBeforeMs) {
    throw new Error("AUTHORITY_KEY_REGISTRY_TIME_WINDOW_INVALID");
  }
  if (entry.verifyUntilMs !== null
    && entry.notAfterMs !== null
    && entry.verifyUntilMs < entry.notAfterMs) {
    throw new Error("AUTHORITY_KEY_REGISTRY_TIME_WINDOW_INVALID");
  }
  const der = Buffer.from(entry.publicKeySpki, "base64url");
  if (der.length === 0 || der.toString("base64url") !== entry.publicKeySpki || authorityKeyId(der) !== entry.keyId) {
    throw new Error("AUTHORITY_KEY_REGISTRY_FINGERPRINT_MISMATCH");
  }
  if (createPublicKey({ key: der, format: "der", type: "spki" }).asymmetricKeyType !== "ed25519") {
    throw new Error("AUTHORITY_KEY_REGISTRY_KEY_TYPE_UNSUPPORTED");
  }
  return { ...entry };
}

function manifestDigest(core: Omit<AuthorityKeyRegistryV1, "manifestDigest">): string {
  return `sha256:${createHash("sha256").update(canonicalJson(core), "utf8").digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function compareEntries(left: AuthorityKeyRegistryEntryV1, right: AuthorityKeyRegistryEntryV1): number {
  const tupleOrder = `${left.authorityId}\0${left.issuer}\0${left.algorithm}\0${left.keyId}\0${left.purpose}`
    .localeCompare(`${right.authorityId}\0${right.issuer}\0${right.algorithm}\0${right.keyId}\0${right.purpose}`);
  if (tupleOrder !== 0) return tupleOrder;
  const generationOrder = left.generation - right.generation;
  return generationOrder !== 0 ? generationOrder : left.state.localeCompare(right.state);
}

function requiredText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`AUTHORITY_KEY_REGISTRY_FIELD_INVALID:${label}`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`AUTHORITY_KEY_REGISTRY_FIELD_INVALID:${label}`);
  return value;
}

function nonNegativeAuthorityInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`AUTHORITY_KEY_REGISTRY_FIELD_INVALID:${label}`);
  return value;
}

function nullableNonNegativeInteger(value: number | null, label: string): void {
  if (value !== null) nonNegativeAuthorityInteger(value, label);
}
