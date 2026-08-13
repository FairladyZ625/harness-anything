import path from "node:path";

export const relationAuthoredSourceManifest = [
  {
    kind: "task-index",
    scope: "task",
    relativePath: "INDEX.md",
    content: "frontmatter"
  }
] as const;

export type RelationAuthoredSourceDefinition = (typeof relationAuthoredSourceManifest)[number];
export type RelationAuthoredSourceKind = RelationAuthoredSourceDefinition["kind"];
export type RelationTaskAuthoredSourceDefinition = Extract<RelationAuthoredSourceDefinition, { readonly scope: "task" }>;

export type RelationTaskAuthoredSource = RelationTaskAuthoredSourceDefinition & { readonly filePath: string };

export function deriveRelationTaskAuthoredSources(taskDir: string): ReadonlyArray<RelationTaskAuthoredSource> {
  return relationAuthoredSourceManifest
    .filter((source): source is RelationTaskAuthoredSourceDefinition => source.scope === "task")
    .map((source) => ({ ...source, filePath: path.join(taskDir, source.relativePath) }));
}
