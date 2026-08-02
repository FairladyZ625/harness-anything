import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { absentHostedDocumentSnapshotV2 } from "@harness-anything/application";
import {
  sha256Text,
  taskPackagePath,
  type RegistryEntityRefV2
} from "@harness-anything/kernel";
import type { CanonicalAttemptIntent } from "./production-authority-attempt-compiler.ts";

export function readTaskDocuments(
  taskRoot: string,
  relativeRoot = ""
): ReadonlyArray<{ readonly path: string; readonly body: string }> {
  const current = path.join(taskRoot, relativeRoot);
  if (!existsSync(current)) return [];
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.posix.join(relativeRoot.split(path.sep).join("/"), entry.name);
    if (entry.isDirectory()) return readTaskDocuments(taskRoot, relativePath);
    if (!entry.isFile()) return [];
    return [{ path: relativePath, body: readFileSync(path.join(taskRoot, relativePath), "utf8") }];
  });
}

export function lifecycleIntent(
  commandName: string,
  payload: Uint8Array,
  mutations: CanonicalAttemptIntent["mutations"],
  baseRefs: ReadonlyArray<RegistryEntityRefV2>,
  portablePaths: ReadonlyArray<string>,
  physicalEntityId: string,
  declaredPathCas: CanonicalAttemptIntent["declaredPathCas"] = []
): CanonicalAttemptIntent {
  return { commandName, payload, mutations, baseRefs, portablePaths, physicalEntityId, declaredPathCas };
}

export function lifecycleMutation(entityKind: string, canonicalRef: string, action: string) {
  return { entity: lifecycleRef(entityKind, canonicalRef), action };
}

export function lifecycleRef(entityKind: string, canonicalRef: string): RegistryEntityRefV2 {
  return { registryVersion: 1, entityKind, canonicalRef };
}

export function requiredLifecycleSnapshot(authoredRoot: string, logicalPath: string, physicalPath = logicalPath) {
  const snapshot = optionalLifecycleSnapshot(authoredRoot, logicalPath, physicalPath);
  if (!snapshot) throw new Error(`AUTHORITY_CANONICAL_HOST_DOCUMENT_REQUIRED:${physicalPath}`);
  return snapshot;
}

export function optionalLifecycleSnapshot(authoredRoot: string, logicalPath: string, physicalPath = logicalPath) {
  const absolute = path.join(authoredRoot, physicalPath);
  if (!existsSync(absolute)) return null;
  const body = readFileSync(absolute, "utf8");
  const digest = sha256Text(body);
  return {
    path: logicalPath,
    body,
    expectedEpoch: digest,
    expectedRevision: 0n,
    expectedBlobDigest: Buffer.from(digest, "hex")
  };
}

export function absentLifecycleSnapshot(logicalPath: string): CanonicalAttemptIntent["declaredPathCas"][number] {
  const absent = absentHostedDocumentSnapshotV2(logicalPath);
  return {
    path: logicalPath,
    expectedEpoch: absent.epoch,
    expectedRevision: absent.revision,
    expectedBlobDigest: absent.blobDigest
  };
}

export function resolvedTaskRoot(authoredRoot: string, taskId: string): string {
  const rootDir = path.dirname(authoredRoot);
  return taskPackagePath({
    rootDir,
    layoutOverrides: { authoredRoot: path.relative(rootDir, authoredRoot) }
  }, taskId);
}

export function taskLifecyclePath(authoredRoot: string, taskId: string, documentPath: string) {
  const physical = path.relative(authoredRoot, path.join(resolvedTaskRoot(authoredRoot, taskId), documentPath))
    .split(path.sep).join("/");
  return { logical: `tasks/${taskId}/${documentPath}`, physical };
}

export function portableLifecyclePaths(
  ...paths: ReadonlyArray<ReturnType<typeof taskLifecyclePath>>
): ReadonlyArray<string> {
  return [...new Set(paths.flatMap((entry) => [entry.logical, entry.physical]))];
}
