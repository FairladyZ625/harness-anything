import path from "node:path";
import { consumeKnownError } from "../error-consumption.ts";
import { isMigrationImportEvent, ledgerCommitSha, type CanonicalEventV1 } from "../domain/doc-sync.contract.ts";
import { type EventHead } from "../domain/write-chain.contract.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { ledgerGitPath, type LedgerGitLayout } from "./ledger-git-layout.ts";
import {
  localGitObjectRefStore as gitObjects,
  localGitWorktreeSettlement as worktree,
} from "./local-version-control-system.ts";
import type {
  EventPublicationKillpoint,
  GitFileMode,
  MaterializationReceipt,
  PublicationFile,
  PublicationWrite,
} from "./task-event-store-types.ts";
import { TaskEventStoreError } from "./task-event-store-types.ts";
import { readBlobAt } from "./task-event-store-reads.ts";
import { canonicalDocumentClaims, canonicalDocumentRetirements } from "./task-event-store-claims-layout.ts";
import { assertPublicationCut } from "./task-event-store-git-refs.ts";
import { committedNode } from "./task-event-store-publication-audit.ts";
import { readStream } from "./task-event-store-reads.ts";

// Worktree settlement, materialization, document modes, and error rendering.
export function settleFiles(
  repoRoot: string,
  commit: string,
  files: readonly PublicationFile[],
  killpoint?: (point: EventPublicationKillpoint) => void,
  whileFilesSync?: () => void,
): number {
  for (const file of files) {
    const logical = "target" in file ? file.target : "delete" in file ? file.delete : null;
    if (logical === null || ("target" in file && !/\.(?:md|txt)$/u.test(logical))) continue;
    const target = path.join(repoRoot, ...logical.split("/")),
      local = worktree.readNode(target);
    if (
      local === null ||
      ("target" in file && local.mode === file.mode && sha256Text(local.body) === sha256Text(file.body))
    )
      continue;
    const parent = committedNode(repoRoot, `${commit}^`, logical),
      current = {
        nodeKind: local.mode === "120000" ? ("symbolic-link" as const) : ("file" as const),
        sha256: local.sha256,
        size: local.size,
      };
    if (
      parent === null ||
      parent.nodeKind !== current.nodeKind ||
      parent.sha256 !== current.sha256 ||
      parent.size !== current.size
    )
      worktree.preserveConflict(repoRoot, target, logical, commit);
  }
  return worktree.settle(repoRoot, files, {
    whileFilesSync,
    beforeRename: () => killpoint?.("before_worktree_rename"),
    afterRename: () => killpoint?.("after_worktree_rename"),
  });
}
export function materialize(
  ledger: LedgerGitLayout,
  repoId: string,
  commit: string,
  head: EventHead | null,
  authoredRef: string,
): MaterializationReceipt {
  assertPublicationCut(ledger.rootDir, authoredRef, commit);
  const latest = new Map<string, { readonly hash: string; readonly mode: GitFileMode }>();
  for (const event of readStream(ledger, commit, head).events) {
    for (const retirement of canonicalDocumentRetirements(event)) latest.delete(retirement.path);
    for (const claim of canonicalDocumentClaims(event))
      latest.set(claim.path, {
        hash: claim.sha256,
        mode: documentMode(event, claim.path),
      });
  }
  const changed: string[] = [],
    conflicts: string[] = [],
    files: PublicationWrite[] = [];
  for (const [logical, { hash, mode }] of [...latest].sort(([left], [right]) => left.localeCompare(right))) {
    const bytes = readBlobAt(ledger, commit, hash);
    if (!bytes) throw new TaskEventStoreError("invalid_store", `materialization blob ${hash} is missing`);
    const body = Buffer.from(bytes).toString("utf8"),
      physical = ledgerGitPath(ledger, logical),
      target = path.join(ledger.rootDir, ...physical.split("/")),
      local = worktree.readNode(target);
    if (local?.mode === mode && sha256Text(local.body) === hash) continue;
    if (local !== null) conflicts.push(worktree.preserveConflict(ledger.rootDir, target, logical, commit));
    changed.push(logical);
    files.push({ target: physical, body, mode });
  }
  if (files.length) settleFiles(ledger.rootDir, commit, files);
  return {
    status: "visible",
    commitSha: ledgerCommitSha(repoId, commit),
    changed,
    conflicts,
  };
}
export function canonicalDocumentMode(event: CanonicalEventV1, documentPath: string): GitFileMode {
  return isMigrationImportEvent(event) &&
    event.payload.entity.kind === "repo-document" &&
    event.payload.entity.nodeKind === "symbolic-link" &&
    event.payload.entity.documentClaim.path === documentPath
    ? "120000"
    : "100644";
}
export const documentMode = canonicalDocumentMode;
export function publicationModes(
  ledger: LedgerGitLayout,
  files: readonly { readonly target: string; readonly body: string }[],
  event: CanonicalEventV1,
): readonly PublicationFile[] {
  const modes = new Map(
    canonicalDocumentClaims(event).map((claim) => [ledgerGitPath(ledger, claim.path), documentMode(event, claim.path)]),
  );
  return files.map((file) => ({
    ...file,
    mode: modes.get(file.target) ?? "100644",
  }));
}
export function showText(repoRoot: string, commit: string, target: string): string | null {
  const bytes = showBytes(repoRoot, commit, target);
  return bytes === null ? null : Buffer.from(bytes).toString("utf8");
}
export function showBytes(repoRoot: string, commit: string, target: string): Uint8Array | null {
  return gitObjects.readPath(repoRoot, commit, target);
}
export function workspacePath(
  workspaceRoot: string,
  authoredRoot: string,
  ledger: LedgerGitLayout,
  target: string,
): string {
  const authored = path.relative(workspaceRoot, authoredRoot).split(path.sep).join("/"),
    prefix = ledger.authoredPrefix ? `${ledger.authoredPrefix}/` : "",
    logical = prefix && target.startsWith(prefix) ? target.slice(prefix.length) : target;
  return authored ? `${authored}/${logical}` : logical;
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function shapeError(body: string, detail: string): TaskEventStoreError {
  let schema = "unknown";
  try {
    const parsed = JSON.parse(body) as { schema?: unknown };
    schema = String(parsed.schema);
  } catch (error) {
    consumeKnownError(error);
  }
  const legacy = /^(?:execution|review|task-holder)\//u.test(schema);
  return new TaskEventStoreError(
    legacy ? "legacy_shape" : "invalid_store",
    legacy ? `${detail}; use the archived CLI on archive/main` : detail,
  );
}
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
