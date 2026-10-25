/** The single declaration source for relation-type semantics. */
export const relationTypeDeclarations = [
  { type: "supports", acyclic: false },
  { type: "supersedes", acyclic: true },
  { type: "refines", acyclic: true },
  { type: "narrows", acyclic: true },
  { type: "derives", acyclic: true },
  { type: "blocks", acyclic: false },
  { type: "relates", acyclic: false },
  { type: "implements", acyclic: false },
  { type: "depends-on", acyclic: true },
  { type: "produces", acyclic: false },
  { type: "evidences", acyclic: false },
  { type: "evidenced-by", acyclic: false },
  { type: "refuted-by", acyclic: false },
  { type: "invalidated-by", acyclic: false },
  { type: "supersedes-fact", acyclic: true },
  { type: "executes", acyclic: false },
  { type: "reviews", acyclic: false },
  { type: "owns", acyclic: false },
  { type: "dispatches", acyclic: false },
  { type: "awaits", acyclic: false },
  { type: "assigned-to", acyclic: false },
] as const satisfies readonly { readonly type: string; readonly acyclic: boolean }[];

export type RelationType = (typeof relationTypeDeclarations)[number]["type"];

/** Relation vocabulary projected from the declarations above for existing schema consumers. */
export const relationTypes = Object.freeze(relationTypeDeclarations.map(({ type }) => type)) as unknown as [
  RelationType,
  ...RelationType[],
];

const declarationsByType = new Map(relationTypeDeclarations.map((declaration) => [declaration.type, declaration]));

export function isAcyclicRelationType(type: RelationType): boolean {
  return declarationsByType.get(type)!.acyclic;
}
