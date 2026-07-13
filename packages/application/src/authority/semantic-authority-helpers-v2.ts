import type { RegistryMutationPlanInput } from "../../../kernel/src/index.ts";
import {
  SemanticAdmissionErrorV2,
  bytesEqual,
  type PathCasV2,
  type RegistryEntityRefV2,
  type SemanticBaseCasV2
} from "./semantic-mutation-envelope-v2.ts";

interface SemanticEntityBaseReaderV2 {
  readonly readEntityBase: (entityRef: RegistryEntityRefV2) => Promise<{
    readonly semanticVersion: string | null;
    readonly stateDigest: Uint8Array | null;
  } | null>;
}

interface SemanticHostedDocumentSnapshotV2 {
  readonly epoch: string;
  readonly revision: bigint;
  readonly blobDigest: Uint8Array;
}

export function semanticAdmissionV2(code: string, message = code): SemanticAdmissionErrorV2 {
  return new SemanticAdmissionErrorV2(code, message);
}

export function exactSemanticObjectV2(
  value: unknown,
  keys: ReadonlyArray<string>,
  options: { readonly name?: string; readonly allowAdditional?: boolean } = {}
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw semanticAdmissionV2("TYPED_PAYLOAD_INVALID");
  }
  const row = value as Record<string, unknown>;
  const actual = Object.keys(row);
  if (keys.some((key) => !actual.includes(key))
    || (!options.allowAdditional && actual.some((key) => !keys.includes(key)))) {
    throw semanticAdmissionV2("TYPED_PAYLOAD_UNKNOWN_OR_MISSING_FIELD", options.name);
  }
  return row;
}

export function semanticStringValueV2(value: unknown): string {
  if (typeof value !== "string") throw semanticAdmissionV2("TYPED_PAYLOAD_INVALID");
  return value;
}

export async function verifySemanticBaseCasV2(
  state: SemanticEntityBaseReaderV2,
  claimed: ReadonlyArray<SemanticBaseCasV2>,
  requiredRefs: ReadonlyArray<RegistryEntityRefV2>
): Promise<void> {
  const required = uniqueRegistryEntityRefsV2(requiredRefs);
  if (claimed.length !== required.length) throw semanticAdmissionV2("BASE_CAS_CONFLICT");
  const byRef = new Map(claimed.map((entry) => [registryEntityRefKeyV2(entry.entityRef), entry]));
  if (byRef.size !== claimed.length) throw semanticAdmissionV2("BASE_CAS_CONFLICT");
  for (const entityRef of required) {
    const row = byRef.get(registryEntityRefKeyV2(entityRef));
    if (!row) throw semanticAdmissionV2("BASE_CAS_CONFLICT");
    const actual = await state.readEntityBase(entityRef);
    if (!actual) {
      if (row.expectedSemanticVersion !== null || row.expectedStateDigest !== null) {
        throw semanticAdmissionV2("BASE_CAS_CONFLICT");
      }
    } else if (row.expectedSemanticVersion !== actual.semanticVersion
      || !nullableSemanticBytesEqualV2(row.expectedStateDigest, actual.stateDigest)) {
      throw semanticAdmissionV2("BASE_CAS_CONFLICT");
    }
  }
}

export function verifySemanticPathCasV2(
  claimed: ReadonlyArray<PathCasV2>,
  required: ReadonlyArray<{ readonly path: string; readonly snapshot: SemanticHostedDocumentSnapshotV2 }>
): void {
  if (claimed.length !== required.length) throw semanticAdmissionV2("BASE_CAS_CONFLICT");
  const byPath = new Map(claimed.map((entry) => [entry.path, entry]));
  if (byPath.size !== claimed.length) throw semanticAdmissionV2("BASE_CAS_CONFLICT");
  for (const { path, snapshot } of required) {
    const row = byPath.get(path);
    if (!row || row.expectedEpoch !== snapshot.epoch || row.expectedRevision !== snapshot.revision
      || !bytesEqual(row.expectedBlobDigest, snapshot.blobDigest)) {
      throw semanticAdmissionV2("BASE_CAS_CONFLICT");
    }
  }
}

export function semanticMutationPlanV2(
  mutations: RegistryMutationPlanInput["mutations"]
): RegistryMutationPlanInput {
  return { registryVersion: 1, mutations };
}

export function nullableSemanticBytesEqualV2(
  left: Uint8Array | null,
  right: Uint8Array | null
): boolean {
  return left === null || right === null ? left === right : bytesEqual(left, right);
}

function registryEntityRefKeyV2(ref: RegistryEntityRefV2): string {
  return `${ref.registryVersion}\0${ref.entityKind}\0${ref.canonicalRef}`;
}

function uniqueRegistryEntityRefsV2(
  refs: ReadonlyArray<RegistryEntityRefV2>
): ReadonlyArray<RegistryEntityRefV2> {
  return [...new Map(refs.map((ref) => [registryEntityRefKeyV2(ref), ref])).values()];
}
