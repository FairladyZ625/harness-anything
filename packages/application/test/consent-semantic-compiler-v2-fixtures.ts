import type {
  HostedDocumentSnapshotV2,
  PathCasV2,
  RegistryEntityRefV2,
  SemanticBaseCasV2,
  SemanticEntityBaseV2,
  SemanticMutationSetV2
} from "../src/index.ts";

export const taskId = "task_01KXPP248WACVWSM7F4K855RWH";
export const executionId = "exe_01KXPP248WACVWSM7F4K855RWJ";
export const consentId = "cns_01KXPP248WACVWSM7F4K855RWK";
export const reviewId = "rev_01KXPP248WACVWSM7F4K855RWM";
export const executionPath = `tasks/${taskId}/executions/${executionId}.md`;
export const consentPath = `tasks/${taskId}/consents/${consentId}.md`;
export const taskIndexPath = `tasks/${taskId}/INDEX.md`;
export const stateDigest = Buffer.alloc(32, 0x41);
export const schemaTuple = {
  wire: 2, event: 2, receipt: 2, digest: 2, policy: 1,
  commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1, localState: 1, applyJournal: 1
} as const;
export const channelNonceDigest = Buffer.alloc(32, 0x22);

export function base(semanticVersion: string): SemanticEntityBaseV2 {
  return { semanticVersion, stateDigest };
}

export function executionRef(): RegistryEntityRefV2 {
  return ref("execution", `execution/${taskId}/${executionId}`);
}

export function consentRef(): RegistryEntityRefV2 {
  return ref("consent", `consent/${taskId}/${consentId}`);
}

export function reviewRef(): RegistryEntityRefV2 {
  return ref("review", `review/${taskId}/${reviewId}`);
}

export function key(entityRef: RegistryEntityRefV2): string {
  return `${entityRef.registryVersion}\0${entityRef.entityKind}\0${entityRef.canonicalRef}`;
}

export function absent(entityRef: RegistryEntityRefV2): SemanticBaseCasV2 {
  return { entityRef, expectedSemanticVersion: null, expectedStateDigest: null };
}

export function present(entityRef: RegistryEntityRefV2, semanticVersion: string): SemanticBaseCasV2 {
  return { entityRef, expectedSemanticVersion: semanticVersion, expectedStateDigest: stateDigest };
}

export function cas(path: string, value: HostedDocumentSnapshotV2): PathCasV2 {
  return { path, expectedEpoch: value.epoch, expectedRevision: value.revision, expectedBlobDigest: value.blobDigest };
}

export function mutationPair(mutation: SemanticMutationSetV2["mutations"][number]): string {
  return `${mutation.entity.canonicalRef}:${mutation.action.action}`;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

export function snapshot(body: string): HostedDocumentSnapshotV2 {
  return { body, epoch: "epoch-w6", revision: 7n, blobDigest: Buffer.alloc(32, 0x77) };
}

export function authorityState(
  bases: ReadonlyMap<string, SemanticEntityBaseV2>,
  documents: ReadonlyMap<string, HostedDocumentSnapshotV2>
) {
  return {
    readEntityBase: async (entityRef: RegistryEntityRefV2) => bases.get(key(entityRef)) ?? null,
    readHostedDocument: async (path: string) => documents.get(path) ?? null
  };
}

function ref(entityKind: string, canonicalRef: string): RegistryEntityRefV2 {
  return { registryVersion: 1, entityKind, canonicalRef };
}
