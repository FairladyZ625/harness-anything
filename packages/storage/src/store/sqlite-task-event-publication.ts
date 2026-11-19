import { authoredNodeFingerprint, type AuthoredNode } from "../authored-node-read.ts";
import { decisionDirectoryRetirements } from "./decision-directory-settlement.ts";
import type { WriteFence } from "../durable-file.ts";
import {
  type EventHead,
  type LedgerCutIdentity,
} from "@harness-anything/kernel/internal/domain/write-chain.contract.ts";
import type { CanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { sha256Bytes } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "@harness-anything/kernel/internal/layout/index.ts";
import { consumeKnownError } from "@harness-anything/kernel/internal/error-consumption";
import { localRuntimeStateFileSystem as conversionFiles } from "@harness-anything/kernel/internal/local/local-layout-file-system.ts";
import {
  canonicalDocumentClaims,
  canonicalDocumentMode,
  canonicalDocumentRetirements,
  canonicalOwnedDirectories,
} from "@harness-anything/kernel/internal/ports/canonical-document-claims.ts";
import { canonicalLedgerCut } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import { resolveLedgerGitLayout, ledgerAuthoredPath, ledgerGitPath } from "./ledger-git-layout.ts";
import {
  alignFollowerIndex,
  localGitObjectRefStore,
  localGitObjectRefStoreAsync,
  localGitWorktreeSettlement,
  localGitWorktreeSettlementAsync,
} from "./local-version-control-system.ts";
import { openSqliteEventStore } from "./sqlite-event-store.ts";
import type { SqliteEventStore } from "./sqlite-event-store.ts";
import type {
  PreservedCopy,
  PublicationFile,
  PublicationWrite,
  PublicationDelete,
} from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import { TaskEventStoreError } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import { publishFollowerCut } from "./task-event-store-git-refs.ts";

export interface CertifiedGitFollower {
  readonly commitSha: string;
  readonly cut: LedgerCutIdentity;
  readonly documents: readonly {
    readonly path: string;
    readonly mode: "100644" | "120000";
    readonly sha256: string;
    readonly size: number;
  }[];
  readonly retirements: readonly string[];
}

export interface FollowerCheckpointSource {
  readonly metadata: () => { readonly repoId: string; readonly generation: number; readonly revision: number };
  readonly eventIdentityAtRevision: (revision: number) => EventHead | null;
}

export function publishConvertedGeneration(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly repoId: string;
  readonly store: SqliteEventStore;
  readonly authoredBranch?: string;
}): { readonly commitSha: string; readonly revision: number; readonly changed: boolean } {
  const layout = resolveHarnessLayout(input.rootInput),
    ledger = resolveLedgerGitLayout(input.rootInput),
    branch = input.authoredBranch ?? localGitObjectRefStore.currentBranch(ledger.rootDir);
  if (!branch) throw new TaskEventStoreError("publication_indeterminate", "authored branch is detached");
  const authoredRef = `refs/heads/${branch}`,
    parent = localGitObjectRefStore.resolveCommit(ledger.rootDir, authoredRef),
    manifestBytes = localGitObjectRefStore.readPath(
      ledger.rootDir,
      parent,
      ledgerGitPath(ledger, followerManifestPath),
    ),
    retiredLegacy = legacyRetirements(ledger, parent),
    snapshot = input.store.readSnapshot(() => {
      const revision = input.store.revision();
      if (revision === 0) return null;
      const cut = canonicalLedgerCut(input.repoId, input.store.eventIdentityAtRevision(revision)),
        closureEvents = readEventsThrough(input.store, revision),
        files = [
          ...followerFiles(
            ledger,
            closureEvents,
            input.store.readContentObject,
            cut,
            input.store.metadata().generation,
          ),
          ...retiredLegacy,
        ],
        directories = followerDirectories(ledger, closureEvents, files, undefined, layout.decisionsRoot),
        checkpoint = certifiedFollowerRevisionFromManifest(manifestBytes, input.store, true);
      return { revision, cut, files, directories, checkpoint };
    });
  if (!snapshot) return { commitSha: parent, revision: 0, changed: false };
  const { revision, cut, files, directories, checkpoint } = snapshot,
    baseline = captureConversionBaseline(input.rootInput, ledger.rootDir, parent, files),
    commit = publishFollowerCut(ledger.rootDir, authoredRef, parent, checkpoint, cut, files);
  if (
    !worktreeMatchesBaseline(ledger.rootDir, baseline, files) ||
    settleWorktree(layout, ledger.rootDir, files, baseline).conflicts.length > 0
  )
    throw new TaskEventStoreError("publication_indeterminate", "authored worktree has concurrent edits");
  settleWorktreeDirectories(ledger.rootDir, directories);
  alignFollowerIndex({
    repoRoot: ledger.rootDir,
    authoredRef,
    authoredPrefix: ledger.authoredPrefix,
    head: commit,
    previous: commit === parent ? `${commit}^` : parent,
    ...(commit === parent ? { visibility: files } : {}),
    retiredLegacyPaths: new Set(retiredLegacy.map((file) => file.delete)),
  });
  return { commitSha: commit, revision, changed: commit !== parent };
}

export function readCertifiedGitFollower(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly repoId: string;
  readonly store: SqliteEventStore;
  readonly authoredBranch?: string;
}): CertifiedGitFollower {
  const ledger = resolveLedgerGitLayout(input.rootInput),
    branch = input.authoredBranch ?? localGitObjectRefStore.currentBranch(ledger.rootDir);
  if (!branch) throw new TaskEventStoreError("publication_indeterminate", "authored branch is detached");
  const commitSha = localGitObjectRefStore.resolveCommit(ledger.rootDir, `refs/heads/${branch}`),
    manifestBytes = localGitObjectRefStore.readPath(
      ledger.rootDir,
      commitSha,
      ledgerGitPath(ledger, followerManifestPath),
    ),
    { cut, closure } = input.store.readSnapshot(() => {
      const revision = certifiedFollowerRevisionFromManifest(manifestBytes, input.store);
      if (revision !== input.store.revision())
        throw new TaskEventStoreError(
          "publication_indeterminate",
          "Git follower does not certify the current SQLite cut",
        );
      return {
        cut: canonicalLedgerCut(input.repoId, input.store.eventIdentityAtRevision(revision)),
        closure: documentClosure(readEventsThrough(input.store, revision)),
      };
    });
  verifyDocumentClosure(ledger, commitSha, closure);
  return {
    commitSha,
    cut,
    documents: [...closure.documents.entries()]
      .map(([path, value]) => ({ path, ...value }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    retirements: [...closure.retirements].sort(),
  };
}

export const FOLLOWER_MANIFEST_PATH = "events/segments/manifest.json";
const followerManifestPath = FOLLOWER_MANIFEST_PATH;

/** The publication of `events`: their documents' latest bytes, their retirements, and last the cut's manifest. */
export function followerFiles(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  events: Iterable<CanonicalEventV1>,
  readContent: (sha256: string) => Uint8Array | null,
  cut: LedgerCutIdentity,
  generation: number,
): (PublicationWrite | PublicationDelete)[] {
  const closure = documentClosure(events);
  return [
    ...[...closure.documents].map(([target, claim]) => {
      const bytes = readContent(claim.sha256);
      if (!bytes || bytes.byteLength !== claim.size || sha256Bytes(bytes) !== claim.sha256)
        throw new TaskEventStoreError("invalid_store", `content object ${claim.sha256} is missing or corrupt`);
      return { target: ledgerGitPath(ledger, target), body: bytes, mode: claim.mode };
    }),
    ...[...closure.retirements].map((target) => ({ delete: ledgerGitPath(ledger, target) })),
    { target: ledgerGitPath(ledger, followerManifestPath), body: followerManifest(generation, cut), mode: "100644" },
  ];
}

/** Build a follower cut from the indexed current document set without replaying event history. */
export function followerFilesFromDocumentHeads(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  heads: readonly {
    readonly path: string;
    readonly sha256: string | null;
    readonly size: number | null;
    readonly nodeKind: "file" | "symbolic-link" | null;
  }[],
  readContent: (sha256: string) => Uint8Array | null,
  cut: LedgerCutIdentity,
  generation: number,
): (PublicationWrite | PublicationDelete)[] {
  const files: (PublicationWrite | PublicationDelete)[] = [];
  for (const head of heads) {
    const target = ledgerGitPath(ledger, head.path);
    if (head.sha256 === null) {
      files.push({ delete: target });
      continue;
    }
    const bytes = readContent(head.sha256);
    if (!bytes || head.size === null || bytes.byteLength !== head.size || sha256Bytes(bytes) !== head.sha256)
      throw new TaskEventStoreError("invalid_store", `content object ${head.sha256} is missing or corrupt`);
    files.push({ target, body: bytes, mode: head.nodeKind === "symbolic-link" ? "120000" : "100644" });
  }
  files.push({
    target: ledgerGitPath(ledger, followerManifestPath),
    body: followerManifest(generation, cut),
    mode: "100644",
  });
  return files;
}

function followerManifest(generation: number, cut: LedgerCutIdentity): string {
  return `${JSON.stringify({ schema: "sqlite-ledger-segment-manifest/v1", generation, cut })}\n`;
}

function retirementsFromIndexedAndTree(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  indexed: readonly string[],
  treeEntries: readonly { readonly target: string }[],
): PublicationDelete[] {
  const retired = new Set(indexed);
  for (const entry of treeEntries) retired.add(entry.target);
  retired.delete(ledgerGitPath(ledger, followerManifestPath));
  return [...retired].map((target) => ({ delete: target }));
}

/** Pre-SQLite paths the index tracks, and with a `parent`, its tree holds: conversion retires both. */
export function legacyRetirements(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  parent: string | null,
): PublicationDelete[] {
  const scopes = [ledgerGitPath(ledger, "events/"), ledgerGitPath(ledger, "objects/sha256/")],
    indexed = localGitWorktreeSettlement.indexedPaths(ledger.rootDir, scopes),
    tree = parent === null ? [] : localGitObjectRefStore.listTree(ledger.rootDir, parent, scopes);
  return retirementsFromIndexedAndTree(ledger, indexed, tree);
}

export async function legacyRetirementsAsync(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  parent: string | null,
): Promise<PublicationDelete[]> {
  const scopes = [ledgerGitPath(ledger, "events/"), ledgerGitPath(ledger, "objects/sha256/")],
    indexed = await localGitWorktreeSettlementAsync.indexedPaths(ledger.rootDir, scopes),
    tree = parent === null ? [] : await localGitObjectRefStoreAsync.listTree(ledger.rootDir, parent, scopes);
  return retirementsFromIndexedAndTree(ledger, indexed, tree);
}

export interface FollowerDirectorySettlement {
  /** Directories no file implies, so materialization has to make them itself. */
  readonly create: readonly string[];
  /** Directories an owner declared before and declares no longer, deepest first so a parent follows its child. */
  readonly retire: readonly string[];
}

/**
 * The directories the accepted events own, and the ones they have released. Each entity event restates its
 * owner's whole set, so the last event of an owner decides both: a deleted owner declares none and names every
 * directory it used to hold. Only paths an event actually names appear here, so nothing that was never declared
 * is ever a retirement candidate no matter what the worktree looks like.
 */
export function followerDirectories(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  events: readonly CanonicalEventV1[],
  files: readonly (PublicationWrite | PublicationDelete)[] = [],
  directoryClaims: readonly NonNullable<ReturnType<typeof canonicalOwnedDirectories>>[] = events.flatMap(
    (event) => canonicalOwnedDirectories(event) ?? [],
  ),
  decisionsRoot?: string,
  decisionsDirectoryOptions?: { readonly cold?: boolean },
): FollowerDirectorySettlement {
  const declaredByOwner = new Map<string, readonly string[]>(),
    retiredByOwner = new Map<string, readonly string[]>();
  for (const owned of directoryClaims) {
    declaredByOwner.set(owned.ownerRef, owned.directories);
    retiredByOwner.set(owned.ownerRef, owned.retirements);
  }
  const retiredFromDocumentSet = files.flatMap((file) => {
    if (!("delete" in file)) return [];
    const logical = ledgerAuthoredPath(ledger, file.delete),
      parts = logical.split("/"),
      root = parts[0] === "tasks" && parts.length > 2 ? parts.slice(0, 2) : null;
    return root === null ? [] : root.map((_, index) => root.slice(0, index + 1).join("/"));
  });
  const decisionDirectories = decisionDirectoryRetirements(
    files.flatMap((file) => ("delete" in file ? [ledgerAuthoredPath(ledger, file.delete)] : [])),
    decisionsRoot,
    decisionsDirectoryOptions,
  ).map((logical) => ledgerGitPath(ledger, logical));
  const create = [...new Set([...declaredByOwner.values()].flat())]
      .map((logical) => ledgerGitPath(ledger, logical))
      .sort(),
    held = new Set(create);
  return {
    create,
    // Reverse path order is depth order: `a/b/c` sorts after `a/b`, which sorts after `a`.
    retire: [
      ...new Set([
        ...[...retiredByOwner.values()]
          .flat()
          .concat(retiredFromDocumentSet)
          .map((logical) => ledgerGitPath(ledger, logical)),
        ...decisionDirectories,
      ]),
    ]
      .filter((directory) => !held.has(directory))
      .sort()
      .reverse(),
  };
}

export function settleWorktreeDirectories(
  repoRoot: string,
  settlement: FollowerDirectorySettlement,
  withFence?: WriteFence,
): void {
  if (settlement.create.length > 0)
    localGitWorktreeSettlement.visible(
      repoRoot,
      settlement.create.map((directory) => ({ directory })),
      { withFence },
    );
  for (const directory of settlement.create)
    if (!localGitWorktreeSettlement.isDirectory(`${repoRoot}/${directory}`))
      throw new TaskEventStoreError(
        "publication_indeterminate",
        `worktree follower did not restore directory ${directory}`,
      );
  if (settlement.retire.length === 0) return;
  // A directory that still holds something is left alone: what the user put there is not the entity's to retire,
  // and neither is any directory that is only standing because it holds it.
  const preserved = new Set(localGitWorktreeSettlement.retireEmptyDirectories(repoRoot, settlement.retire, withFence));
  for (const directory of settlement.retire)
    if (!preserved.has(directory) && localGitWorktreeSettlement.isDirectory(`${repoRoot}/${directory}`))
      throw new TaskEventStoreError(
        "publication_indeterminate",
        `worktree follower did not retire directory ${directory}`,
      );
}

/**
 * The revision whose cut `commit`'s manifest binds by head digest. Content addressing binds the rest of the tree to
 * that commit, so it is not re-rendered here; `readCertifiedGitFollower` is the full read-back.
 */
export function certifiedFollowerRevisionFromManifest(
  bytes: Buffer | null,
  source: FollowerCheckpointSource,
  resetPriorGeneration = false,
): number {
  return bytes ? manifestRevision(bytes, source, resetPriorGeneration) : 0;
}

export function peekFollowerManifestRevision(bytes: Buffer | null): number | null {
  if (!bytes) return null;
  const match = /"cut"\s*:\s*\{[^}]*"revision"\s*:\s*([0-9]+)\b/u.exec(bytes.toString("utf8"));
  if (!match) return null;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

export function certifiedFollowerRevision(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  commit: string,
  source: FollowerCheckpointSource,
  resetPriorGeneration = false,
): number {
  const bytes = localGitObjectRefStore.readPath(ledger.rootDir, commit, ledgerGitPath(ledger, followerManifestPath));
  return certifiedFollowerRevisionFromManifest(bytes, source, resetPriorGeneration);
}

/** The revision the worktree's own manifest names, or 0 (settle the whole closure) when it names no SQLite cut. */
export function physicalWorktreeRevision(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  source: FollowerCheckpointSource,
): number {
  const node = localGitWorktreeSettlement.readNode(`${ledger.rootDir}/${ledgerGitPath(ledger, followerManifestPath)}`);
  if (node?.mode !== "100644") return 0;
  return manifestRevision(node.bytes, source);
}

function manifestRevision(bytes: Buffer, source: FollowerCheckpointSource, resetPriorGeneration = false): number {
  const parsed = decodeFollowerManifest(bytes),
    revision = Number(parsed.cut?.revision),
    metadata = source.metadata();
  // A prior generation cannot certify any prefix of this ledger, even at the same integer revision.
  if (
    ((metadata.generation === 3 && (parsed.generation === 1 || parsed.generation === 2)) ||
      (resetPriorGeneration && metadata.generation === 2 && parsed.generation === 1)) &&
    parsed.cut?.repoId === metadata.repoId &&
    Number.isSafeInteger(revision) &&
    revision >= 0
  )
    return 0;
  if (
    parsed.generation !== metadata.generation ||
    parsed.cut?.repoId !== metadata.repoId ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    revision > metadata.revision
  )
    throw new TaskEventStoreError("publication_indeterminate", "Git follower manifest identity is invalid");
  const expected = canonicalLedgerCut(metadata.repoId, source.eventIdentityAtRevision(revision));
  if (parsed.cut.headDigest !== expected.headDigest)
    throw new TaskEventStoreError("publication_indeterminate", "Git follower manifest cut differs from SQLite");
  return revision;
}

/** What the ledger held at `revision` for each target: what a worktree settled there holds until settled again. */
export function ledgerWorktreeBaseline(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  sqlite: ReturnType<typeof openSqliteEventStore>,
  revision: number,
  files: readonly (PublicationWrite | PublicationDelete)[],
): ReadonlyMap<string, string> {
  const identity = sqlite.eventIdentityAtRevision(revision),
    held = new Map(
      [...documentClosure(identity ? readEventsThrough(sqlite, revision) : []).documents].map(([logical, document]) => [
        ledgerGitPath(ledger, logical),
        `${document.mode}:${document.sha256}:${document.size}`,
      ]),
    );
  if (identity) {
    const manifest = followerManifest(
      sqlite.metadata().generation,
      canonicalLedgerCut(sqlite.metadata().repoId, identity),
    );
    held.set(
      ledgerGitPath(ledger, followerManifestPath),
      `100644:${publicationDigest(manifest)}:${Buffer.byteLength(manifest)}`,
    );
  }
  return new Map(
    files.map((file) => {
      const target = "target" in file ? file.target : file.delete;
      return [target, held.get(target) ?? "missing"];
    }),
  );
}

/**
 * Only a manifest that is not JSON is undecodable; one that decodes but names no cut SQLite holds is reported as
 * that, so a decode verdict never hides the identity failure that actually happened.
 */
function decodeFollowerManifest(bytes: Buffer): {
  readonly generation?: unknown;
  readonly cut?: { repoId?: unknown; revision?: unknown; headDigest?: unknown };
} {
  const undecodable = () =>
    new TaskEventStoreError("publication_indeterminate", "Git follower manifest cannot be decoded");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    consumeKnownError(error);
    throw undecodable();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw undecodable();
  return parsed as ReturnType<typeof decodeFollowerManifest>;
}

export function readEventsThrough(
  sqlite: ReturnType<typeof openSqliteEventStore>,
  revision: number,
): readonly CanonicalEventV1[] {
  return [...followerEventsAfter(sqlite.eventsAfter, 0, revision)];
}

export function readPendingEvents(
  sqlite: ReturnType<typeof openSqliteEventStore>,
  revision: number,
  throughRevision: number = sqlite.revision(),
): readonly CanonicalEventV1[] {
  return [...followerEventsAfter(sqlite.eventsAfter, revision, throughRevision)];
}

/** Yields the uncertified suffix a bounded source page at a time. */
export function* followerEventsAfter(
  readEvents: (afterRevision: number, limit: number) => readonly CanonicalEventV1[],
  checkpointRevision: number,
  targetRevision: number,
): Generator<CanonicalEventV1> {
  let cursor = checkpointRevision;
  while (cursor < targetRevision) {
    const page = readEvents(cursor, Math.min(4096, targetRevision - cursor));
    if (page.length === 0)
      throw new TaskEventStoreError("publication_indeterminate", "canonical follower event suffix is incomplete");
    yield* page;
    cursor = page.at(-1)!.workspaceRevision;
  }
}

function documentClosure(events: Iterable<CanonicalEventV1>): {
  readonly documents: ReadonlyMap<
    string,
    { readonly mode: "100644" | "120000"; readonly sha256: string; readonly size: number }
  >;
  readonly retirements: ReadonlySet<string>;
} {
  const documents = new Map<
      string,
      { readonly mode: "100644" | "120000"; readonly sha256: string; readonly size: number }
    >(),
    retirements = new Set<string>();
  for (const event of events) {
    for (const retirement of canonicalDocumentRetirements(event)) {
      documents.delete(retirement.path);
      retirements.add(retirement.path);
    }
    for (const claim of canonicalDocumentClaims(event)) {
      documents.set(claim.path, {
        mode: canonicalDocumentMode(event, claim.path),
        sha256: claim.sha256,
        size: claim.size,
      });
      retirements.delete(claim.path);
    }
  }
  return { documents, retirements };
}

function verifyDocumentClosure(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  commit: string,
  closure: ReturnType<typeof documentClosure>,
): void {
  const tree = new Map(
      localGitObjectRefStore
        .listTree(ledger.rootDir, commit, [
          ...[...closure.documents.keys()].map((logical) => ledgerGitPath(ledger, logical)),
          ...[...closure.retirements].map((logical) => ledgerGitPath(ledger, logical)),
        ])
        .map((entry) => [entry.target, entry] as const),
    ),
    bodies = localGitObjectRefStore.readPaths(
      ledger.rootDir,
      commit,
      [...closure.documents.keys()].flatMap((logical) => {
        const entry = tree.get(ledgerGitPath(ledger, logical));
        return entry ? [{ target: entry.target, size: entry.size, oid: entry.oid }] : [];
      }),
    );
  for (const [logical, expected] of closure.documents) {
    const target = ledgerGitPath(ledger, logical),
      bytes = bodies.get(target) ?? null;
    if (
      bytes === null ||
      bytes.byteLength !== expected.size ||
      sha256Bytes(bytes) !== expected.sha256 ||
      tree.get(target)?.mode !== expected.mode
    )
      throw new TaskEventStoreError("publication_indeterminate", `Git follower document differs at ${logical}`);
  }
  for (const logical of closure.retirements)
    if (tree.has(ledgerGitPath(ledger, logical)))
      throw new TaskEventStoreError("publication_indeterminate", `Git follower retirement differs at ${logical}`);
}

/** Returns the targets a caller changed before their rename: they keep the caller's bytes, the rest still settle. */
export function settleWorktree(
  layout: ReturnType<typeof resolveHarnessLayout>,
  repoRoot: string,
  files: readonly PublicationFile[],
  baseline: ReadonlyMap<string, string>,
  killpoint?: (
    point: import("@harness-anything/kernel/internal/ports/task-event-store.ts").EventPublicationKillpoint,
  ) => void,
  preserve: ReadonlySet<string> = new Set(),
  commit = "",
  withFence?: WriteFence,
): { readonly conflicts: readonly string[]; readonly preserved: readonly PreservedCopy[] } {
  const deletes = files.flatMap((file) => ("delete" in file ? [file.delete] : [])),
    writes = files.flatMap((file) => ("target" in file ? [file] : [])),
    conflicts: string[] = [],
    preserved: PreservedCopy[] = [];
  for (const target of deletes)
    if (
      !settleVisibleChange(
        repoRoot,
        target,
        "missing",
        baseline,
        killpoint,
        (hooks) => localGitWorktreeSettlement.deleteVisible(repoRoot, [target], hooks),
        withFence,
      )
    )
      conflicts.push(target);
  for (const file of writes) {
    const digest = publicationDigest(file.body),
      absolute = `${repoRoot}/${file.target}`;
    if (
      !settleVisibleChange(
        repoRoot,
        file.target,
        `${file.mode}:${digest}:${Buffer.byteLength(file.body)}`,
        baseline,
        killpoint,
        (hooks) => {
          if (preserve.has(file.target)) {
            hooks.beforeRename();
            const node = localGitWorktreeSettlement.readNode(absolute);
            if (node && node.sha256 !== digest)
              preserved.push({
                target: file.target,
                copy: localGitWorktreeSettlement.preserveVisibleConflict(layout, absolute, file.target, commit),
              });
          }
          localGitWorktreeSettlement.visible(repoRoot, [file], hooks);
        },
        withFence,
      )
    )
      conflicts.push(file.target);
  }
  return { conflicts, preserved };
}

export function settleVisibleChange(
  repoRoot: string,
  target: string,
  settled: string,
  baseline: ReadonlyMap<string, string>,
  killpoint:
    | ((point: import("@harness-anything/kernel/internal/ports/task-event-store.ts").EventPublicationKillpoint) => void)
    | undefined,
  apply: (hooks: {
    readonly beforeRename: () => void;
    readonly afterRename: () => void;
    readonly withFence?: WriteFence;
  }) => void,
  withFence?: WriteFence,
): boolean {
  let changed = false;
  const conflict = new Error("authored worktree changed during settlement");
  try {
    const hooks = {
      withFence,
      beforeRename: () => {
        killpoint?.("before_worktree_rename");
        const current = worktreeFingerprint(localGitWorktreeSettlement.readNode(`${repoRoot}/${target}`));
        if (current !== baseline.get(target) && current !== settled) {
          changed = true;
          throw conflict;
        }
      },
      afterRename: () => killpoint?.("after_worktree_rename"),
    };
    apply(hooks);
  } catch (error) {
    if (changed && error === conflict) return false;
    throw error;
  }
  return true;
}

/** Offline conversion preserves the restored draft overlay before settling accepted content. */
export function captureConversionBaseline(
  rootInput: HarnessLayoutInput,
  repoRoot: string,
  parent: string,
  files: readonly PublicationFile[],
): ReadonlyMap<string, string> {
  const baseline = new Map(captureGitBaseline(repoRoot, parent, files).worktree);
  const drafts: { path: string; mode: string | null; sha256: string | null; preservedPath: string | null }[] = [];
  for (const file of files) {
    const target = "target" in file ? file.target : "delete" in file ? file.delete : null;
    if (target === null) continue;
    const node = localGitWorktreeSettlement.readNode(`${repoRoot}/${target}`);
    const current = worktreeFingerprint(node);
    const settled =
      "target" in file ? `${file.mode}:${publicationDigest(file.body)}:${Buffer.byteLength(file.body)}` : "missing";
    if (current === baseline.get(target) || current === settled) continue;
    const preservedPath = node
      ? localGitWorktreeSettlement.preserveConflict(
          resolveHarnessLayout(rootInput),
          `${repoRoot}/${target}`,
          target,
          parent,
        )
      : null;
    if (
      node &&
      localGitWorktreeSettlement.readNode(`${resolveHarnessLayout(rootInput).rootDir}/${preservedPath}`)?.sha256 !==
        node.sha256
    )
      throw new TaskEventStoreError("publication_indeterminate", `draft preservation differs: ${target}`);
    drafts.push({ path: target, mode: node?.mode ?? null, sha256: node?.sha256 ?? null, preservedPath });
    baseline.set(target, current);
  }
  if (drafts.length) {
    const directory = `${resolveHarnessLayout(rootInput).localRoot}/operations/conversion-drafts/${parent}`;
    conversionFiles.mkdirp(directory);
    const manifest = `${JSON.stringify({ schema: "conversion-drafts/v1", parent, drafts }, null, 2)}\n`;
    const target = `${directory}/manifest.json`;
    if (!conversionFiles.createExclusiveText(target, manifest) && conversionFiles.readText(target) !== manifest)
      throw new TaskEventStoreError("publication_indeterminate", "conversion draft preservation manifest differs");
  }
  return baseline;
}

function gitBaselineTargets(files: readonly PublicationFile[]): readonly string[] {
  return files.flatMap((file) => {
    const target = "target" in file ? file.target : "delete" in file ? file.delete : null;
    return target === null ? [] : [target];
  });
}

function buildBaselineFromTree(
  targets: readonly string[],
  tree: ReadonlyMap<string, { readonly mode: "100644" | "120000"; readonly oid: string; readonly size: number }>,
  bodies: ReadonlyMap<string, Buffer>,
): ReadonlyMap<string, string> {
  return new Map(
    targets.map((target) => {
      const bytes = bodies.get(target) ?? null;
      return [
        target,
        bytes === null ? "missing" : `${tree.get(target)?.mode}:${sha256Bytes(bytes)}:${bytes.byteLength}`,
      ];
    }),
  );
}

type GitBaseline = {
  readonly worktree: ReadonlyMap<string, string>;
  readonly tree: ReadonlyMap<string, { readonly mode: string; readonly oid: string }>;
};

export function captureGitBaseline(repoRoot: string, commit: string, files: readonly PublicationFile[]): GitBaseline {
  const targets = gitBaselineTargets(files),
    tree = new Map(
      localGitObjectRefStore.listTree(repoRoot, commit, targets).map((entry) => [entry.target, entry] as const),
    ),
    bodies = localGitObjectRefStore.readPaths(
      repoRoot,
      commit,
      targets.flatMap((target) => {
        const entry = tree.get(target);
        return entry ? [{ target, size: entry.size, oid: entry.oid }] : [];
      }),
    );
  return { worktree: buildBaselineFromTree(targets, tree, bodies), tree };
}

export async function captureGitBaselineAsync(
  repoRoot: string,
  commit: string,
  files: readonly PublicationFile[],
): Promise<GitBaseline> {
  const targets = gitBaselineTargets(files),
    tree = new Map(
      (await localGitObjectRefStoreAsync.listTree(repoRoot, commit, targets)).map(
        (entry) => [entry.target, entry] as const,
      ),
    ),
    bodies = await localGitObjectRefStoreAsync.readPaths(
      repoRoot,
      commit,
      targets.flatMap((target) => {
        const entry = tree.get(target);
        return entry ? [{ target, size: entry.size, oid: entry.oid }] : [];
      }),
    );
  return { worktree: buildBaselineFromTree(targets, tree, bodies), tree };
}

export function worktreeMatchesBaseline(
  repoRoot: string,
  baseline: ReadonlyMap<string, string>,
  files: readonly PublicationFile[],
): boolean {
  const settled = new Map(
    files.flatMap((file) =>
      "target" in file
        ? [[file.target, `${file.mode}:${publicationDigest(file.body)}:${Buffer.byteLength(file.body)}`]]
        : "delete" in file
          ? [[file.delete, "missing"]]
          : [],
    ),
  );
  for (const [target, fingerprint] of baseline) {
    const current = worktreeFingerprint(localGitWorktreeSettlement.readNode(`${repoRoot}/${target}`));
    if (current !== fingerprint && current !== settled.get(target)) return false;
  }
  return true;
}

function publicationBytes(body: string | Uint8Array): Buffer {
  return typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.isBuffer(body) ? body : Buffer.from(body);
}

export function publicationDigest(body: string | Uint8Array): string {
  return sha256Bytes(publicationBytes(body));
}

export function worktreeFingerprint(node: AuthoredNode | null): string {
  return authoredNodeFingerprint(node);
}
