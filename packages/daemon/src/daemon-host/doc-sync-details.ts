import { existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import {
  resolveHarnessLayout,
  sha256Bytes,
  type DocClaimRef,
  type DocWriteIntent,
  type WriteSource,
} from "@harness-anything/kernel";
import { localProseSource } from "./doc-sync-files.ts";
import { readAuthoredDocumentBytes } from "./authored-document-read-port.ts";

export {
  blockedCandidateNextAction,
  detail,
  holder,
  matches,
  touch,
} from "@harness-anything/application/internal/queries/doc-sync-details.ts";

export function claimBytes(rootDir: string, ref: DocClaimRef): Uint8Array | null {
  const target = claimFile(rootDir, ref);
  return target && lstatSync(target).isFile() ? readFileSync(target) : null;
}

export function claimFile(rootDir: string, ref: string): string | null {
  let target = resolveHarnessLayout(rootDir).localRoot;
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) return null;
  for (const segment of ref.split("/")) {
    target = path.join(target, segment);
    if (!existsSync(target) || lstatSync(target).isSymbolicLink()) return null;
  }
  return target;
}

export function recycleClaims(rootDir: string, intent: DocWriteIntent): void {
  for (const change of intent.changes) {
    const target = change.candidate && claimFile(rootDir, change.candidate.ref);
    if (target) /* @gate-identity state-store/document.claim-recycle */ unlinkSync(target);
  }
}

export function directPaths(rootDir: string, paths: readonly string[]): boolean {
  const authored = resolveHarnessLayout(rootDir).authoredRoot;
  if (existsSync(authored) && lstatSync(authored).isSymbolicLink()) return false;
  return paths.every((document) => {
    let target = authored;
    for (const segment of document.split("/")) {
      target = path.join(target, segment);
      if (existsSync(target) && lstatSync(target).isSymbolicLink()) return false;
    }
    return true;
  });
}

export function observe(
  rootDir: string,
  source: WriteSource,
  documents: readonly ({
    readonly path: string;
    readonly blobSha256: string;
  } | null)[],
): boolean | null {
  if (!localProseSource(source) || documents.some((document) => document === null)) return null;
  const authored = resolveHarnessLayout(rootDir).authoredRoot;
  return documents.every((document) => {
    const target = path.join(authored, document!.path);
    return (
      existsSync(target) && sha256Bytes(readAuthoredDocumentBytes(authored, document!.path)) === document!.blobSha256
    );
  });
}
