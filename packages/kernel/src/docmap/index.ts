import path from "node:path";
import { Effect, Schema } from "effect";
import type { DocmapDocument, DocmapManifest, DocmapReadSet } from "../domain/docmap.ts";
import type { ArtifactStoreError } from "../domain/index.ts";
import { normalizeRelativeDocumentPath, resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import type { ArtifactStore } from "../ports/artifact-store.ts";
import { DocmapManifestSchema } from "../schemas/docmap.ts";
import { assertUniqueDocmapIds } from "./docmap-unique.ts";

export interface DocmapReadResult {
  readonly manifest: DocmapManifest;
  readonly path: string;
  readonly relativePath: string;
}

export interface DocmapReadSetFilters {
  readonly moduleKey?: string;
  readonly productLine?: string;
}

export function docmapManifestPath(rootInput: HarnessLayoutInput): string {
  return path.join(resolveHarnessLayout(rootInput).authoredRoot, "docmap.json");
}

export function readDocmapManifest(rootInput: HarnessLayoutInput, artifactStore: Pick<ArtifactStore, "readAuthoredDocument">): DocmapReadResult {
  const layout = resolveHarnessLayout(rootInput);
  const manifestPath = docmapManifestPath(rootInput);
  const document = Effect.runSync(Effect.either(artifactStore.readAuthoredDocument("docmap.json")));
  if (document._tag === "Left") {
    if (!isMissingAuthoredDocument(document.left)) throw artifactReadError(document.left);
    return {
      manifest: { schema: "docmap/v1", documents: [] },
      path: manifestPath,
      relativePath: relativeToRoot(layout.rootDir, manifestPath)
    };
  }
  const decoded = Schema.decodeUnknownSync(DocmapManifestSchema)(JSON.parse(document.right.body)) as DocmapManifest;
  const documents = decoded.documents.map((document) => ({
    ...document,
    path: normalizeRelativeDocumentPath(document.path)
  }));
  assertUniqueDocmapIds(documents);
  return {
    manifest: {
      schema: "docmap/v1",
      documents: documents.sort(compareDocuments)
    },
    path: manifestPath,
    relativePath: relativeToRoot(layout.rootDir, manifestPath)
  };
}

export function buildDocmapReadSet(
  manifest: DocmapManifest,
  filters: DocmapReadSetFilters
): DocmapReadSet {
  const active = manifest.documents.filter((document) => !document.supersededBy);
  const mandatory = active.filter((document) => matchesScope(document, filters)).sort(compareDocuments);
  const mandatoryIds = new Set(mandatory.map((document) => document.id));
  const recommended = active
    .filter((document) => !mandatoryIds.has(document.id))
    .filter((document) => document.scope.modules.length === 0 && document.scope.productLines.length === 0)
    .sort(compareDocuments);
  return { mandatory, recommended };
}

export function filterDocmapDocuments(
  manifest: DocmapManifest,
  filters: DocmapReadSetFilters
): ReadonlyArray<DocmapDocument> {
  return manifest.documents
    .filter((document) => !filters.moduleKey || document.scope.modules.includes(filters.moduleKey))
    .filter((document) => !filters.productLine || document.scope.productLines.includes(filters.productLine))
    .sort(compareDocuments);
}

function matchesScope(document: DocmapDocument, filters: DocmapReadSetFilters): boolean {
  const moduleMatches = filters.moduleKey ? document.scope.modules.includes(filters.moduleKey) : false;
  const productLineMatches = filters.productLine ? document.scope.productLines.includes(filters.productLine) : false;
  return moduleMatches || productLineMatches;
}

function compareDocuments(left: DocmapDocument, right: DocmapDocument): number {
  return left.path.localeCompare(right.path, "en-US") || left.id.localeCompare(right.id, "en-US");
}

function relativeToRoot(rootDir: string, targetPath: string): string {
  return path.relative(rootDir, targetPath).split(path.sep).join("/");
}

function isMissingAuthoredDocument(error: ArtifactStoreError): boolean {
  if (error._tag !== "ArtifactReadFailed") return false;
  return error.cause instanceof Error
    && /authored document not found/u.test(error.cause.message);
}

function artifactReadError(error: ArtifactStoreError): Error {
  if (error._tag !== "ArtifactReadFailed") return new Error(error._tag);
  return error.cause instanceof Error ? error.cause : new Error(String(error.cause));
}
