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
import type { ArtifactStoreError, EngineId, ExternalRef, TaskId } from "../domain/index.ts";
import { sha256Text } from "./hash.ts";

export interface MarkdownArtifactStoreOptions {
  readonly rootDir: string;
}

export function makeMarkdownArtifactStore(options: MarkdownArtifactStoreOptions): ArtifactStore {
  const rootDir = path.resolve(options.rootDir);

  return {
    readTaskPackage: (taskId) => Effect.try({
      try: () => readTaskPackage(rootDir, taskId),
      catch: (cause): ArtifactStoreError => ({
        _tag: "ArtifactReadFailed",
        path: packagePath(rootDir, taskId),
        cause
      })
    }),
    findBindingByExternalRef: (engine, ref) => Effect.try({
      try: () => findBindingByExternalRef(rootDir, engine, ref),
      catch: (cause): ArtifactStoreError => ({
        _tag: "ArtifactReadFailed",
        path: path.join(rootDir, "tasks"),
        cause
      })
    })
  };
}

export function makeMarkdownArtifactStoreWriter(options: MarkdownArtifactStoreOptions): ArtifactStoreWriter {
  const rootDir = path.resolve(options.rootDir);

  return {
    writeDocument: (write) => Effect.try({
      try: () => writeDocument(rootDir, write),
      catch: (cause): ArtifactStoreError => ({
        _tag: "ArtifactWriteRejected",
        path: write.path,
        reason: cause instanceof Error ? cause.message : "write failed"
      })
    }),
    archivePackage: (taskId) => Effect.try({
      try: () => archiveTaskPackage(rootDir, taskId),
      catch: (cause): ArtifactStoreError => ({
        _tag: "ArtifactWriteRejected",
        path: packagePath(rootDir, taskId),
        reason: cause instanceof Error ? cause.message : "archive failed"
      })
    })
  };
}

export function findBindingByExternalRef(
  rootDir: string,
  engine: EngineId,
  ref: ExternalRef
): Option.Option<TaskId> {
  const tasksDir = path.join(rootDir, "tasks");
  if (!existsSync(tasksDir)) return Option.none();
  for (const taskId of readdirSync(tasksDir).sort()) {
    const indexPath = path.join(tasksDir, taskId, "INDEX.md");
    if (!existsSync(indexPath)) continue;
    const frontmatter = readFileSync(indexPath, "utf8").match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? "";
    if (readScalar(frontmatter, "  engine") === engine && readScalar(frontmatter, "  ref") === ref) {
      return Option.some(taskId);
    }
  }
  return Option.none();
}

function readScalar(frontmatter: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return frontmatter.match(new RegExp(`^${escaped}:\\s*(.*)$`, "mu"))?.[1]?.trim() ?? "";
}

export function writeDocument(rootDir: string, write: DocumentWrite): ArtifactWriteReceipt {
  const targetPath = documentPath(rootDir, write);
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

export function readTaskPackage(rootDir: string, taskId: TaskId): TaskPackageRead {
  const rootPath = packagePath(rootDir, taskId);
  if (!existsSync(rootPath)) {
    throw new Error(`task package not found: ${taskId}`);
  }

  return {
    taskId,
    rootPath,
    disposition: "active",
    documents: readDocuments(rootPath)
  };
}

function archiveTaskPackage(rootDir: string, taskId: TaskId): TaskPackageRead {
  const sourcePath = packagePath(rootDir, taskId);
  if (!existsSync(sourcePath)) throw new Error(`task package not found: ${taskId}`);

  const archiveRoot = path.join(rootDir, ".archived");
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
  return documents.sort((left, right) => left.path.localeCompare(right.path));
}

function documentPath(rootDir: string, write: DocumentWrite): string {
  const safePath = normalizeRelativePath(write.path);
  return path.join(packagePath(rootDir, write.taskId), safePath);
}

function packagePath(rootDir: string, taskId: TaskId): string {
  return path.join(rootDir, "tasks", normalizeTaskId(taskId));
}

function normalizeTaskId(taskId: TaskId): string {
  if (taskId.length === 0 || taskId.includes("/") || taskId.includes("..")) {
    throw new Error(`invalid task id: ${taskId}`);
  }
  return taskId;
}

function normalizeRelativePath(value: string): string {
  if (path.isAbsolute(value)) throw new Error(`absolute paths are not allowed: ${value}`);
  const normalized = path.normalize(value);
  if (normalized.startsWith("..") || normalized === ".") {
    throw new Error(`path must stay inside task package: ${value}`);
  }
  return normalized;
}
