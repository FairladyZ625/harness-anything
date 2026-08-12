import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Effect, Option } from "effect";
import type { ArtifactDocument, ArtifactStore, TaskPackageRead } from "../ports/artifact-store.ts";
import type { ArtifactStoreError, EngineId, ExternalRef, TaskId } from "../domain/index.ts";
import { isPackageDisposition, type PackageDisposition } from "../domain/package-disposition.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { readFrontmatter, readScalar } from "../markdown/frontmatter.ts";
import type { HarnessLayoutInput, HarnessLayoutOverrides } from "../layout/index.ts";
import { assertNoPortablePathCollisions, findTaskIdByExternalRef, normalizeRelativeDocumentPath, resolveHarnessLayout, taskPackagePath, validateTaskIdSyntax } from "../layout/index.ts";
export interface MarkdownArtifactStoreOptions { readonly rootDir: string; readonly layoutOverrides?: HarnessLayoutOverrides }
export function makeMarkdownArtifactStore(options: MarkdownArtifactStoreOptions): ArtifactStore { const rootInput = options.layoutOverrides
  ? { rootDir: path.resolve(options.rootDir), layoutOverrides: options.layoutOverrides } : path.resolve(options.rootDir);
  return { readTaskPackage: (taskId) => Effect.try({ try: () => readTaskPackage(rootInput, taskId), catch: (cause): ArtifactStoreError => ({ _tag: "ArtifactReadFailed", path: taskPackagePath(rootInput, taskId), cause }) }),
    readAuthoredDocument: (documentPath) => Effect.try({ try: () => readAuthoredDocument(rootInput, documentPath), catch: (cause): ArtifactStoreError => ({ _tag: "ArtifactReadFailed", path: documentPath, cause }) }),
    findBindingByExternalRef: (engine, ref) => Effect.try({ try: () => findBindingByExternalRef(rootInput, engine, ref),
      catch: (cause): ArtifactStoreError => ({ _tag: "ArtifactReadFailed", path: resolveHarnessLayout(rootInput).tasksRoot, cause }) }) }; }
export function findBindingByExternalRef(rootInput: HarnessLayoutInput, engine: EngineId, ref: ExternalRef): Option.Option<TaskId> {
  return Option.fromNullable(findTaskIdByExternalRef(rootInput, engine, ref)); }
export function readTaskPackage(rootInput: HarnessLayoutInput, taskId: TaskId): TaskPackageRead { validateTaskIdSyntax(taskId);
  const rootPath = taskPackagePath(rootInput, taskId); if (!existsSync(rootPath)) throw new Error(`task package not found: ${taskId}`);
  return { taskId, rootPath, disposition: disposition(rootPath, taskId), documents: documents(rootPath) }; }
export function readAuthoredDocument(rootInput: HarnessLayoutInput, documentPath: string): ArtifactDocument { const safePath = normalizeRelativeDocumentPath(documentPath);
  const body = readFileSync(path.join(resolveHarnessLayout(rootInput).authoredRoot, safePath), "utf8"); return { path: safePath, body, sha256: sha256Text(body) }; }
function disposition(rootPath: string, taskId: TaskId): PackageDisposition { const index = path.join(rootPath, "INDEX.md"); if (!existsSync(index)) return "active";
  const frontmatter = readFrontmatter(readFileSync(index, "utf8")); if (!frontmatter) throw new Error(`task package frontmatter missing: ${taskId}`);
  const raw = readScalar(frontmatter, "packageDisposition") || "active"; if (!isPackageDisposition(raw)) throw new Error(`invalid package disposition: ${taskId}`); return raw; }
function documents(rootPath: string): readonly ArtifactDocument[] { const out: ArtifactDocument[] = []; const visit = (dir: string): void => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
  const full = path.join(dir, entry.name); if (entry.isDirectory()) visit(full); else { const body = readFileSync(full, "utf8"); out.push({ path: path.relative(rootPath, full).split(path.sep).join("/"), body, sha256: sha256Text(body) }); } } };
  visit(rootPath); assertNoPortablePathCollisions(out.map((item) => item.path)); return out.sort((a, b) => a.path.localeCompare(b.path)); }
