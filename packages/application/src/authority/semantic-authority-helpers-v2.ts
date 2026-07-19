import {
  entityRegistry,
  stablePayloadHash,
  type RegistryMutationPlanInput,
  type SemanticDiffCandidateTree,
  type SemanticDiffDocumentPolicy,
  type SemanticDiffMutationIntent
} from "@harness-anything/kernel";
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

export interface ManagedSemanticDiffRegistrationV2 {
  readonly kind: "task" | "decision" | "fact" | "relation";
  readonly semanticDiff: typeof entityRegistry.task.semanticDiff;
}

export const managedSemanticDiffRegistrationsV2: ReadonlyArray<ManagedSemanticDiffRegistrationV2> = [
  { kind: "task", semanticDiff: entityRegistry.task.semanticDiff },
  { kind: "decision", semanticDiff: entityRegistry.decision.semanticDiff },
  { kind: "fact", semanticDiff: entityRegistry.fact.semanticDiff },
  { kind: "relation", semanticDiff: entityRegistry.relation.semanticDiff }
];

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
  if (claimed.length !== required.length) {
    throw semanticAdmissionV2(`ENTITY_BASE_CAS_CONFLICT:claimed=${claimed.length};required=${required.length}`);
  }
  const byRef = new Map(claimed.map((entry) => [registryEntityRefKeyV2(entry.entityRef), entry]));
  if (byRef.size !== claimed.length) throw semanticAdmissionV2("ENTITY_BASE_CAS_CONFLICT:duplicate-claimed-ref");
  for (const entityRef of required) {
    const refKey = registryEntityRefKeyV2(entityRef);
    const refLabel = `${entityRef.entityKind}:${entityRef.canonicalRef}`;
    const row = byRef.get(refKey);
    if (!row) throw semanticAdmissionV2(`ENTITY_BASE_CAS_CONFLICT:missing=${refLabel}`);
    const actual = await state.readEntityBase(entityRef);
    if (!actual) {
      if (row.expectedSemanticVersion !== null || row.expectedStateDigest !== null) {
        throw semanticAdmissionV2(`ENTITY_BASE_CAS_CONFLICT:expected-absent=${refLabel}`);
      }
    } else if (row.expectedSemanticVersion !== actual.semanticVersion
      || !nullableSemanticBytesEqualV2(row.expectedStateDigest, actual.stateDigest)) {
      throw semanticAdmissionV2(`ENTITY_BASE_CAS_CONFLICT:snapshot-mismatch=${refLabel}`);
    }
  }
}

export function verifySemanticPathCasV2(
  claimed: ReadonlyArray<PathCasV2>,
  required: ReadonlyArray<{ readonly path: string; readonly snapshot: SemanticHostedDocumentSnapshotV2 }>
): void {
  if (claimed.length !== required.length) {
    throw semanticAdmissionV2(`PATH_CAS_CONFLICT:claimed=${claimed.length};required=${required.length}`);
  }
  const byPath = new Map(claimed.map((entry) => [entry.path, entry]));
  if (byPath.size !== claimed.length) throw semanticAdmissionV2("PATH_CAS_CONFLICT:duplicate-claimed-path");
  for (const { path, snapshot } of required) {
    const row = byPath.get(path);
    if (!row || row.expectedEpoch !== snapshot.epoch || row.expectedRevision !== snapshot.revision
      || !bytesEqual(row.expectedBlobDigest, snapshot.blobDigest)) {
      throw semanticAdmissionV2(`PATH_CAS_CONFLICT:${row ? "snapshot-mismatch" : "missing"}=${path}`);
    }
  }
}

export function semanticMutationPlanV2(
  mutations: RegistryMutationPlanInput["mutations"]
): RegistryMutationPlanInput {
  return { registryVersion: 1, mutations };
}

export function compileManagedCandidateTreeV2(
  base: SemanticDiffCandidateTree,
  candidate: SemanticDiffCandidateTree,
  documentPolicies: ReadonlyArray<SemanticDiffDocumentPolicy>,
  registrations: ReadonlyArray<ManagedSemanticDiffRegistrationV2> = managedSemanticDiffRegistrationsV2
): RegistryMutationPlanInput {
  const relevantKinds = managedSemanticKindsForCandidate(base, candidate);
  const intents = registrations.filter((registration) => relevantKinds.has(registration.kind)).flatMap((registration) =>
    registration.semanticDiff.compile(base, candidate, { documentPolicies }));
  return semanticMutationPlanV2(mergeSemanticDiffIntentsV2(intents));
}

function managedSemanticKindsForCandidate(
  base: SemanticDiffCandidateTree,
  candidate: SemanticDiffCandidateTree
): ReadonlySet<ManagedSemanticDiffRegistrationV2["kind"]> {
  const baseBodies = new Map(base.documents.map((document) => [document.path, document.body]));
  const candidateBodies = new Map(candidate.documents.map((document) => [document.path, document.body]));
  const kinds = new Set<ManagedSemanticDiffRegistrationV2["kind"]>();
  for (const documentPath of new Set([...baseBodies.keys(), ...candidateBodies.keys()])) {
    if (baseBodies.get(documentPath) === candidateBodies.get(documentPath)) continue;
    if (/^tasks\/[^/]+\/facts\.md$/u.test(documentPath)) {
      kinds.add("fact");
      kinds.add("relation");
    } else if (/^tasks\/[^/]+\//u.test(documentPath)) {
      kinds.add("task");
    } else if (/^decisions\/decision-[^/]+\/decision\.md$/u.test(documentPath)) {
      kinds.add("decision");
    }
  }
  return kinds;
}

function mergeSemanticDiffIntentsV2(
  intents: ReadonlyArray<SemanticDiffMutationIntent>
): ReadonlyArray<RegistryMutationPlanInput["mutations"][number]> {
  const byMutation = new Map<string, RegistryMutationPlanInput["mutations"][number]>();
  for (const intent of intents) {
    const key = `${intent.entityKind}\0${stablePayloadHash(intent.identity)}\0${intent.action}`;
    const existing = byMutation.get(key);
    const contexts = [
      ...(existing?.storageContext ? [existing.storageContext] : []),
      ...(existing?.additionalStorageContexts ?? []),
      ...(intent.storageContext ? [intent.storageContext] : []),
      ...(intent.additionalStorageContexts ?? [])
    ];
    const uniqueContexts = [...new Map(contexts.map((context) => [stablePayloadHash(context), context])).values()];
    byMutation.set(key, {
      entityKind: intent.entityKind,
      identity: intent.identity,
      action: intent.action,
      ...(uniqueContexts[0] ? { storageContext: uniqueContexts[0] } : {}),
      ...(uniqueContexts.length > 1 ? { additionalStorageContexts: uniqueContexts.slice(1) } : {})
    });
  }
  return [...byMutation.values()].sort((left, right) => Buffer.from(
    `${left.entityKind}\0${stablePayloadHash(left.identity)}\0${left.action}`
  ).compare(Buffer.from(`${right.entityKind}\0${stablePayloadHash(right.identity)}\0${right.action}`)));
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
