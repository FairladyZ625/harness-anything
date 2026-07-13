import { validatePortableManagedPath } from "./policy.ts";
import { FoldedComponentTrie } from "./trie.ts";
import type { ManagedObjectKind, PortablePathDescriptor, PortablePathOptions } from "./types.ts";

export interface ExistingManagedPath {
  readonly path: string;
  readonly kind?: ManagedObjectKind;
}

export interface NamespaceAdmissionService {
  readonly admitNewPath: (path: string, kind?: ManagedObjectKind) => PortablePathDescriptor | undefined;
  readonly hasExistingPath: (path: string) => boolean;
}

export function createNamespaceAdmissionService(
  existing: ReadonlyArray<string | ExistingManagedPath> = [],
  options: PortablePathOptions = {}
): NamespaceAdmissionService {
  const existingPaths = new Set<string>();
  const trie = new FoldedComponentTrie();
  for (const entry of existing) {
    const managedPath = typeof entry === "string" ? entry : entry.path;
    const kind = typeof entry === "string" ? "file" : entry.kind ?? "file";
    existingPaths.add(managedPath);
    seedFoldablePath(trie, managedPath, kind);
  }
  return {
    admitNewPath: (managedPath, kind = "file") => {
      if (existingPaths.has(managedPath)) return undefined;
      const descriptor = validatePortableManagedPath(managedPath, options);
      trie.admit(descriptor.segments, kind, managedPath);
      existingPaths.add(managedPath);
      return descriptor;
    },
    hasExistingPath: (managedPath) => existingPaths.has(managedPath)
  };
}

function seedFoldablePath(trie: FoldedComponentTrie, managedPath: string, kind: ManagedObjectKind): void {
  const segments = managedPath.split("/");
  if (segments.some((segment) => segment.length === 0 || !/^[\x20-\x7e]+$/u.test(segment))) return;
  trie.seed(segments, kind);
}
