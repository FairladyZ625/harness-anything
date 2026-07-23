import type { ReplicaChangeRecord } from "@harness-anything/application";
import { entityRegistry } from "@harness-anything/kernel";

export function replicaChangeOperationIdsForPath(
  change: ReplicaChangeRecord,
  changedPath: string
): ReadonlyArray<string> {
  if (change.operations.length === 1 && !change.operations[0]?.authorityIntegrity) {
    return [change.opId];
  }
  if (change.operations.some((operation) => !operation.authorityIntegrity)) {
    throw new Error("BROKER_REPLICA_CHANGE_OPERATION_INTEGRITY_REQUIRED");
  }
  return change.operations.flatMap((operation) => {
    const targets = operation.authorityIntegrity!.canonicalMutationSet.mutations.flatMap((mutation) => {
      const registration = entityRegistry[mutation.entity.entityKind as keyof typeof entityRegistry];
      if (!registration
        || registration.projectionFacet.status !== "ready"
        || registration.storageLocator.status !== "ready") {
        throw new Error(`BROKER_REPLICA_CHANGE_ENTITY_UNAVAILABLE:${mutation.entity.entityKind}`);
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
    const permitsTaskPackageAlias = targets.some((target) => target.path.startsWith("tasks/"));
    return targets.some((target) =>
      pathMatchesMutationTarget(changedPath, target, permitsTaskPackageAlias))
      ? [operation.opId]
      : [];
  });
}

function pathMatchesMutationTarget(
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
