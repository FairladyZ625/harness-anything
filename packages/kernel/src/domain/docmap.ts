export const docmapDocumentKinds = ["adr", "standard", "architecture", "roadmap", "task", "research", "other"] as const;

export type DocmapDocumentKind = typeof docmapDocumentKinds[number];

export interface DocmapScope {
  readonly modules: ReadonlyArray<string>;
  readonly productLines: ReadonlyArray<string>;
}

export interface DocmapDocument {
  readonly id: string;
  readonly path: string;
  readonly kind: DocmapDocumentKind;
  readonly scope: DocmapScope;
  readonly updatedAt: string;
  readonly supersedes?: ReadonlyArray<string>;
  readonly supersededBy?: string;
  readonly unused?: boolean;
}

export interface DocmapManifest {
  readonly schema: "docmap/v1";
  readonly documents: ReadonlyArray<DocmapDocument>;
}

export interface DocmapReadSet {
  readonly mandatory: ReadonlyArray<DocmapDocument>;
  readonly recommended: ReadonlyArray<DocmapDocument>;
}
