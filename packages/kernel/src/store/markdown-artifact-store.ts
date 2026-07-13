import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect, Option } from "effect";
import type {
  ArtifactDocument,
  ArtifactDocumentKind,
  ArtifactStore,
  AuthoredDocumentDescriptor,
  TaskPackageRead
} from "../ports/artifact-store.ts";
import type {
  ArtifactWriteReceipt,
  DocumentWrite
} from "../ports/artifact-store-writer.ts";
import { isPackageDisposition } from "../domain/index.ts";
import type { ArtifactStoreError, EngineId, ExternalRef, PackageDisposition, TaskId } from "../domain/index.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { readFrontmatter, readScalar } from "../markdown/frontmatter.ts";
import type { HarnessLayoutInput, HarnessLayoutOverrides } from "../layout/index.ts";
import { assertNoPortablePathCollisions, createTaskPackagePath, findTaskIdByExternalRef, normalizeRelativeDocumentPath, resolveHarnessLayout, taskPackagePath, validateTaskIdSyntax } from "../layout/index.ts";

export interface MarkdownArtifactStoreOptions {
  readonly rootDir: string;
  readonly layoutOverrides?: HarnessLayoutOverrides;
}

export function makeMarkdownArtifactStore(options: MarkdownArtifactStoreOptions): ArtifactStore {
  const rootDir = path.resolve(options.rootDir);
  const rootInput = options.layoutOverrides ? { rootDir, layoutOverrides: options.layoutOverrides } : rootDir;

  return {
    readTaskPackage: (taskId) => Effect.try({
      try: () => readTaskPackage(rootInput, taskId),
      catch: (cause): ArtifactStoreError => ({
        _tag: "ArtifactReadFailed",
        path: packagePath(rootInput, taskId),
        cause
      })
    }),
    listAuthoredDocuments: () => Effect.try({
      try: () => listAuthoredDocuments(rootInput),
      catch: (cause): ArtifactStoreError => ({
        _tag: "ArtifactReadFailed",
        path: resolveHarnessLayout(rootInput).authoredRoot,
        cause
      })
    }),
    readAuthoredDocument: (documentPath) => Effect.try({
      try: () => readAuthoredDocument(rootInput, documentPath),
      catch: (cause): ArtifactStoreError => ({
        _tag: "ArtifactReadFailed",
        path: documentPath,
        cause
      })
    }),
    findBindingByExternalRef: (engine, ref) => Effect.try({
      try: () => findBindingByExternalRef(rootInput, engine, ref),
      catch: (cause): ArtifactStoreError => ({
        _tag: "ArtifactReadFailed",
        path: resolveHarnessLayout(rootInput).tasksRoot,
        cause
      })
    })
  };
}

function listAuthoredDocuments(rootInput: HarnessLayoutInput): ReadonlyArray<AuthoredDocumentDescriptor> {
  const authoredRoot = resolveHarnessLayout(rootInput).authoredRoot;
  if (!existsSync(authoredRoot)) return [];
  const documents: AuthoredDocumentDescriptor[] = [];

  function visit(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (classifyArtifactPath(entry.name) !== "document") continue;
      documents.push({ path: path.relative(authoredRoot, fullPath).split(path.sep).join("/") });
    }
  }

  visit(authoredRoot);
  assertNoPortablePathCollisions(documents.map((document) => document.path));
  return documents.sort((left, right) => left.path.localeCompare(right.path));
}

export function findBindingByExternalRef(
  rootInput: HarnessLayoutInput,
  engine: EngineId,
  ref: ExternalRef
): Option.Option<TaskId> {
  return Option.fromNullable(findTaskIdByExternalRef(rootInput, engine, ref));
}

export function writeDocument(rootInput: HarnessLayoutInput, write: DocumentWrite): ArtifactWriteReceipt {
  assertDocumentWritePathsDoNotCollide(rootInput, [write]);
  const targetPath = documentPath(rootInput, write);
  mkdirSync(path.dirname(targetPath), { recursive: true });

  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, write.body, "utf8");
  renameSync(tempPath, targetPath);

  return {
    taskId: write.taskId,
    path: write.path,
    sha256: sha256Text(write.body)
  };
}

export function assertDocumentWritePathsDoNotCollide(
  rootInput: HarnessLayoutInput,
  writes: ReadonlyArray<DocumentWrite>
): void {
  const candidatesByRoot = new Map<string, string[]>();
  for (const write of writes) {
    const target = documentTarget(rootInput, write);
    const candidates = candidatesByRoot.get(target.rootPath) ?? [];
    candidates.push(target.safePath);
    candidatesByRoot.set(target.rootPath, candidates);
  }
  for (const [rootPath, candidates] of candidatesByRoot) {
    assertNoWritePathCollisions(rootPath, candidates);
  }
}

export function readTaskPackage(rootInput: HarnessLayoutInput, taskId: TaskId): TaskPackageRead {
  const rootPath = packagePath(rootInput, taskId);
  if (!existsSync(rootPath)) {
    throw new Error(`task package not found: ${taskId}`);
  }

  return {
    taskId,
    rootPath,
    disposition: readPackageDisposition(rootPath, taskId),
    documents: readDocuments(rootPath)
  };
}

export function readAuthoredDocument(rootInput: HarnessLayoutInput, documentPath: string): ArtifactDocument {
  const safePath = normalizeRelativeDocumentPath(documentPath);
  const fullPath = path.join(resolveHarnessLayout(rootInput).authoredRoot, safePath);
  if (!existsSync(fullPath)) {
    throw new Error(`authored document not found: ${safePath}`);
  }
  const body = readFileSync(fullPath, "utf8");
  return {
    path: safePath,
    kind: classifyArtifactPath(safePath),
    body,
    sha256: sha256Text(body)
  };
}

function readPackageDisposition(rootPath: string, taskId: TaskId): PackageDisposition {
  const indexPath = path.join(rootPath, "INDEX.md");
  if (!existsSync(indexPath)) return "active";

  const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8"));
  if (!frontmatter) throw new Error(`task package frontmatter missing: ${taskId}`);

  const rawDisposition = readScalar(frontmatter, "packageDisposition");
  const disposition = rawDisposition === "" ? "active" : rawDisposition;
  if (!isPackageDisposition(disposition)) {
    throw new Error(`invalid package disposition: ${taskId}`);
  }
  return disposition;
}

function readDocuments(rootPath: string): ReadonlyArray<ArtifactDocument> {
  const documents: ArtifactDocument[] = [];

  function visit(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }

      const body = readFileSync(fullPath, "utf8");
      documents.push({
        path: path.relative(rootPath, fullPath).split(path.sep).join("/"),
        kind: classifyArtifactPath(entry.name),
        body,
        sha256: sha256Text(body)
      });
    }
  }

  visit(rootPath);
  assertNoPortablePathCollisions(documents.map((document) => document.path));
  return documents.sort((left, right) => left.path.localeCompare(right.path));
}

function classifyArtifactPath(documentPath: string): ArtifactDocumentKind {
  return path.extname(documentPath).toLowerCase() === ".md" ? "document" : "attachment";
}

function documentPath(rootInput: HarnessLayoutInput, write: DocumentWrite): string {
  return documentTarget(rootInput, write).targetPath;
}

interface DocumentTarget {
  readonly rootPath: string;
  readonly safePath: string;
  readonly targetPath: string;
}

function documentTarget(rootInput: HarnessLayoutInput, write: DocumentWrite): DocumentTarget {
  const safePath = normalizeRelativeDocumentPath(write.path);
  const rootPath = existsSync(taskPackagePath(rootInput, write.taskId))
    ? taskPackagePath(rootInput, write.taskId)
    : createTaskPackagePath(rootInput, write.taskId, write.packageSlug);
  return {
    rootPath,
    safePath,
    targetPath: path.join(rootPath, safePath)
  };
}

function assertNoWritePathCollisions(rootPath: string, candidatePaths: ReadonlyArray<string>): void {
  const entries = [
    ...listDocumentPaths(rootPath),
    ...candidatePaths
  ];
  const byCanonical = new Map<string, Set<string>>();
  for (const entry of entries) {
    const normalized = normalizeRelativeDocumentPath(entry);
    const canonical = normalized.toLocaleLowerCase("en-US");
    const paths = byCanonical.get(canonical) ?? new Set<string>();
    paths.add(entry);
    byCanonical.set(canonical, paths);
  }

  for (const paths of byCanonical.values()) {
    if (paths.size > 1 && candidatePaths.some((candidate) => paths.has(candidate))) {
      throw new Error(`portable path collision before write: ${[...paths].sort().join(", ")}`);
    }
  }
}

function listDocumentPaths(rootPath: string): ReadonlyArray<string> {
  if (!existsSync(rootPath)) return [];
  const paths: string[] = [];

  function visit(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      paths.push(path.relative(rootPath, fullPath).split(path.sep).join("/"));
    }
  }

  visit(rootPath);
  return paths;
}

function packagePath(rootInput: HarnessLayoutInput, taskId: TaskId): string {
  return taskPackagePath(rootInput, normalizeTaskId(taskId));
}

function normalizeTaskId(taskId: TaskId): string {
  validateTaskIdSyntax(taskId);
  return taskId;
}
