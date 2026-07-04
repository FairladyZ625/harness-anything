import type { DocmapDocument } from "../domain/docmap.ts";

export function assertUniqueDocmapIds(documents: ReadonlyArray<DocmapDocument>): void {
  const seen = new Map<string, string>();
  const collisions: string[] = [];
  for (const document of documents) {
    const previousPath = seen.get(document.id);
    if (!previousPath) {
      seen.set(document.id, document.path);
      continue;
    }
    collisions.push(`${document.id}: ${previousPath} <-> ${document.path}`);
  }
  if (collisions.length > 0) {
    throw new Error(`Docmap manifest contains duplicate document ids:\n${collisions.join("\n")}`);
  }
}
