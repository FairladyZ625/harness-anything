import { foldPortableComponent } from "./policy.ts";
import { NamespaceAdmissionError, type ManagedObjectKind } from "./types.ts";

interface TrieNode {
  readonly spelling: string;
  kind: ManagedObjectKind;
  readonly children: Map<string, TrieNode>;
}

export class FoldedComponentTrie {
  private readonly root: TrieNode = { spelling: "", kind: "directory", children: new Map() };

  admit(segments: ReadonlyArray<string>, kind: ManagedObjectKind = "file", managedPath = segments.join("/")): void {
    const planned: Array<{ readonly parent: TrieNode; readonly key: string; readonly node: TrieNode }> = [];
    let current = this.root;
    for (const [index, spelling] of segments.entries()) {
      const key = foldPortableComponent(spelling);
      const last = index === segments.length - 1;
      const wantedKind: ManagedObjectKind = last ? kind : "directory";
      const existing = current.children.get(key) ?? planned.find((entry) => entry.parent === current && entry.key === key)?.node;
      if (existing) {
        if (existing.spelling !== spelling) {
          throw new NamespaceAdmissionError("CASE_COLLISION", `folded component ${JSON.stringify(spelling)} conflicts with canonical spelling ${JSON.stringify(existing.spelling)}`, managedPath);
        }
        if (!last && existing.kind === "file") {
          throw new NamespaceAdmissionError("FILE_ANCESTOR", `file component ${JSON.stringify(spelling)} cannot be an ancestor`, managedPath);
        }
        if (last) {
          if (existing.kind !== wantedKind) throw new NamespaceAdmissionError("KIND_COLLISION", `component ${JSON.stringify(spelling)} already has kind ${existing.kind}`, managedPath);
          throw new NamespaceAdmissionError("DUPLICATE_PATH", `managed path already exists: ${managedPath}`, managedPath);
        }
        current = existing;
        continue;
      }
      const node: TrieNode = { spelling, kind: wantedKind, children: new Map() };
      planned.push({ parent: current, key, node });
      current = node;
    }
    for (const entry of planned) entry.parent.children.set(entry.key, entry.node);
  }

  seed(segments: ReadonlyArray<string>, kind: ManagedObjectKind = "file"): void {
    try {
      this.admit(segments, kind);
    } catch (error) {
      if (!(error instanceof NamespaceAdmissionError) || error.code !== "DUPLICATE_PATH") throw error;
    }
  }
}
