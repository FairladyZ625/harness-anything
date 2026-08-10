import {
  entityRegistry,
  type PhysicalChangeV2,
  type SemanticMutationSetV2
} from "@harness-anything/kernel";
import { AuthorityImmutablePublicationProofError } from "./publication-proof-error.ts";

/** Fail closed unless every observed tree change is covered by the canonical registry mutation set. */
export function assertPublicationMatchesMutationSet(
  evidence: {
    readonly physicalChanges: ReadonlyArray<PhysicalChangeV2>;
    readonly pipelineGeneratedPaths: ReadonlyArray<string>;
    readonly contentAddressedPaths: ReadonlyArray<string>;
  },
  mutationSet: SemanticMutationSetV2
): void {
  const targets = mutationSet.mutations.flatMap((mutation) => {
    const registration = entityRegistry[mutation.entity.entityKind as keyof typeof entityRegistry];
    if (!registration || registration.projectionFacet.status !== "ready" || registration.storageLocator.status !== "ready") {
      throw new Error(`AUTHORITY_PUBLICATION_ENTITY_UNAVAILABLE:${mutation.entity.entityKind}`);
    }
    const identity = registration.projectionFacet.resolveCanonicalRef(mutation.entity.canonicalRef);
    try {
      return registration.storageLocator.locator.locate(identity, {}).targets
        .filter((target): target is typeof target & { readonly path: string } => Boolean(target.path));
    } catch (error) {
      if (mutation.entity.entityKind === "relation"
        && error instanceof Error
        && error.message === "RELATION_STORAGE_SOURCE_REQUIRED") return [];
      throw error;
    }
  });
  const permitsContentAddressedBlob = mutationSet.mutations.some((mutation) => mutation.entity.entityKind === "session");
  const permitsTaskPackageAlias = targets.some((target) => target.path.startsWith("tasks/"));
  if (evidence.physicalChanges.length === 0) {
    throw new AuthorityImmutablePublicationProofError("AUTHORITY_PUBLICATION_TREE_EMPTY");
  }
  for (const change of evidence.physicalChanges) {
    if (evidence.pipelineGeneratedPaths.includes(change.path)) continue;
    if (permitsContentAddressedBlob && evidence.contentAddressedPaths.includes(change.path)) continue;
    if (!targets.some((target) => publicationChangeMatchesTarget(change.path, target, permitsTaskPackageAlias))) {
      throw publicationTreeMismatchError(change.path, targets, evidence.physicalChanges, permitsTaskPackageAlias);
    }
  }
  for (const target of targets) {
    const observed = evidence.physicalChanges.some((change) =>
      publicationChangeMatchesTarget(change.path, target, permitsTaskPackageAlias)
    );
    if (!observed) {
      throw new AuthorityImmutablePublicationProofError(
        "AUTHORITY_PUBLICATION_DECLARED_PATH_MISSING",
        target.path
      );
    }
  }
}

function publicationChangeMatchesTarget(
  changedPath: string,
  target: { readonly path: string; readonly access: string },
  permitsTaskPackageAlias: boolean
): boolean {
  if (changedPath === target.path) return true;
  if (target.access !== "exact" && changedPath.startsWith(`${target.path}/`)) return true;
  if (!permitsTaskPackageAlias || !target.path.startsWith("tasks/")) return false;
  const targetMatch = /^(tasks\/[^/]+)(\/.*)?$/u.exec(target.path);
  const changedMatch = /^(tasks\/[^/]+)(\/.*)?$/u.exec(changedPath);
  if (!targetMatch?.[1] || !changedMatch?.[1]) return false;
  if (!changedMatch[1].startsWith(`${targetMatch[1]}-`)) return false;
  const slug = changedMatch[1].slice(targetMatch[1].length);
  if (!/^-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(slug)) return false;
  const targetSuffix = targetMatch[2] ?? "";
  const changedSuffix = changedMatch[2] ?? "";
  return target.access === "exact"
    ? changedSuffix === targetSuffix
    : changedSuffix === targetSuffix || changedSuffix.startsWith(`${targetSuffix}/`);
}

function publicationTreeMismatchError(
  changedPath: string,
  targets: ReadonlyArray<{ readonly path: string; readonly access: string }>,
  physicalChanges: ReadonlyArray<PhysicalChangeV2>,
  taskPackageAliasAllowed: boolean
): AuthorityImmutablePublicationProofError {
  return new AuthorityImmutablePublicationProofError(
    "AUTHORITY_PUBLICATION_TREE_MISMATCH",
    [
      changedPath,
      `expectedTargets=${targets.map((target) => `${target.access}:${target.path}`).join(",") || "none"}`,
      `observedPaths=${physicalChanges.map((change) => change.path).join(",") || "none"}`,
      `taskPackageAliasAllowed=${String(taskPackageAliasAllowed)}`
    ].join(";")
  );
}
