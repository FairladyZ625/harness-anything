import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect, Option } from "effect";
import type {
  ArtifactDocument,
  ArtifactStore,
  TaskPackageRead
} from "../ports/artifact-store.ts";
import type {
  ArtifactStoreWriter,
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

export function makeMarkdownArtifactStoreWriter(options: MarkdownArtifactStoreOptions): ArtifactStoreWriter {
  const rootDir = path.resolve(options.rootDir);
  const rootInput = options.layoutOverrides ? { rootDir, layoutOverrides: options.layoutOverrides } : rootDir;

  return {
    writeDocument: (write) => Effect.try({
      try: () => writeDocument(rootInput, write),
      catch: (cause): ArtifactStoreError => ({
        _tag: "ArtifactWriteRejected",
        path: write.path,
        reason: cause instanceof Error ? cause.message : "write failed"
      })
    }),
    archivePackage: (taskId) => Effect.try({
      try: () => archiveTaskPackage(rootInput, taskId),
      catch: (cause): ArtifactStoreError => ({
        _tag: "ArtifactWriteRejected",
        path: packagePath(rootInput, taskId),
        reason: cause instanceof Error ? cause.message : "archive failed"
      })
    })
  };
}

export function findBindingByExternalRef(
  rootInput: HarnessLayoutInput,
  engine: EngineId,
  ref: ExternalRef
): Option.Option<TaskId> {
  return Option.fromNullable(findTaskIdByExternalRef(rootInput, engine, ref));
}

export function writeDocument(rootInput: HarnessLayoutInput, write: DocumentWrite): ArtifactWriteReceipt {
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

function archiveTaskPackage(rootInput: HarnessLayoutInput, taskId: TaskId): TaskPackageRead {
  const sourcePath = packagePath(rootInput, taskId);
  if (!existsSync(sourcePath)) throw new Error(`task package not found: ${taskId}`);

  const archiveRoot = path.join(resolveHarnessLayout(rootInput).rootDir, ".archived");
  const targetPath = path.join(archiveRoot, taskId);
  mkdirSync(archiveRoot, { recursive: true });
  renameSync(sourcePath, targetPath);

  return {
    taskId,
    rootPath: targetPath,
    disposition: "archived",
    documents: readDocuments(targetPath)
  };
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
        body,
        sha256: sha256Text(body)
      });
    }
  }

  visit(rootPath);
  assertNoPortablePathCollisions(documents.map((document) => document.path));
  return documents.sort((left, right) => left.path.localeCompare(right.path));
}

function documentPath(rootInput: HarnessLayoutInput, write: DocumentWrite): string {
  const safePath = normalizeRelativeDocumentPath(write.path);
  const rootPath = existsSync(taskPackagePath(rootInput, write.taskId))
    ? taskPackagePath(rootInput, write.taskId)
    : createTaskPackagePath(rootInput, write.taskId, write.packageSlug);
  return path.join(rootPath, safePath);
}

function packagePath(rootInput: HarnessLayoutInput, taskId: TaskId): string {
  return taskPackagePath(rootInput, normalizeTaskId(taskId));
}

function normalizeTaskId(taskId: TaskId): string {
  validateTaskIdSyntax(taskId);
  return taskId;
}
