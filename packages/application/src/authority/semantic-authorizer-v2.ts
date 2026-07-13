import { isPortablePath } from "./actor-axes-binding-v2.ts";
import type { VerifiedActorAxesBindingV2, ResourceScopeV2 } from "./actor-axes-binding-v2.ts";
import {
  SemanticAdmissionErrorV2,
  type RegistryEntityRefV2,
  type SemanticMutationEnvelopeV2
} from "./semantic-mutation-envelope-v2.ts";

export type EntityRefPrefixMatcherV2 = (
  scope: Extract<ResourceScopeV2, { readonly kind: "entity-ref-prefix" }>,
  entity: RegistryEntityRefV2
) => boolean;

export function authorizeSemanticCompilationV2(
  envelope: SemanticMutationEnvelopeV2,
  touchedPaths: ReadonlyArray<string>,
  decodedBytes: bigint,
  verified: VerifiedActorAxesBindingV2,
  matchEntityRefPrefix?: EntityRefPrefixMatcherV2
): void {
  const claims = verified.token.claims;
  const mutations = envelope.claimedMutationSet.mutations;
  if (envelope.claimedMutationSet.registryVersion !== claims.schemaTuple.mutationRegistry) {
    throw new SemanticAdmissionErrorV2("MUTATION_REGISTRY_VERSION_MISMATCH");
  }
  if (decodedBytes < 0n || decodedBytes > claims.maxBytes) throw new SemanticAdmissionErrorV2("TOKEN_BYTE_LIMIT_EXCEEDED");
  if (mutations.length > claims.maxMutations) throw new SemanticAdmissionErrorV2("TOKEN_MUTATION_LIMIT_EXCEEDED");
  for (const mutation of mutations) {
    if (!claims.allowedEntityKinds.includes(mutation.entity.entityKind)) throw new SemanticAdmissionErrorV2("TOKEN_ENTITY_KIND_SCOPE_DENIED");
    if (!claims.allowedActions.includes(mutation.action.action)) throw new SemanticAdmissionErrorV2("TOKEN_ACTION_SCOPE_DENIED");
    const covered = claims.resourceScopes.some((scope) => {
      if (scope.kind === "workspace") return true;
      if (scope.kind === "entity-ref") return scope.entityRef.registryVersion === mutation.entity.registryVersion
        && scope.entityRef.entityKind === mutation.entity.entityKind
        && scope.entityRef.canonicalRef === mutation.entity.canonicalRef;
      if (scope.kind !== "entity-ref-prefix" || scope.entityKind !== mutation.entity.entityKind) return false;
      // OQ-6 stays fail-closed: only the selected registry identity codec may
      // interpret an entity prefix. Portable path prefixes are specified below.
      return matchEntityRefPrefix ? matchEntityRefPrefix(scope, mutation.entity) : false;
    });
    if (!covered) throw new SemanticAdmissionErrorV2("TOKEN_ENTITY_SCOPE_DENIED");
  }
  for (const path of touchedPaths) {
    if (!isPortablePath(path)) throw new SemanticAdmissionErrorV2("AUTHORITY_TOUCHED_PATH_INVALID");
    const resourceCovered = claims.resourceScopes.some((scope) => scope.kind === "workspace"
      || (scope.kind === "portable-path" && scope.path === path)
      || (scope.kind === "portable-path-prefix" && segmentPrefix(scope.path, path)));
    if (!resourceCovered) throw new SemanticAdmissionErrorV2("TOKEN_PATH_SCOPE_DENIED");
    if (claims.pathFootprint) {
      const covered = claims.pathFootprint.exactPaths.includes(path)
        || claims.pathFootprint.prefixPaths.some((prefix) => segmentPrefix(prefix, path));
      if (!covered) throw new SemanticAdmissionErrorV2("TOKEN_PATH_FOOTPRINT_EXCEEDED");
    }
  }
}

function segmentPrefix(prefix: string, value: string): boolean {
  return value === prefix || (value.startsWith(prefix) && value.charCodeAt(prefix.length) === 0x2f);
}

