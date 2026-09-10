import { type EventHead, type LedgerCutIdentity } from "../domain/write-chain.contract.ts";
import { serializePersistedCanonicalEvent, type CanonicalEventV1 } from "../domain/doc-sync.contract.ts";
import { sha256Bytes, sha256Text } from "../integrity/stable-hash.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import { consumeKnownError } from "../error-consumption.ts";
import { localRuntimeStateFileSystem as conversionFiles } from "../local/local-layout-file-system.ts";
import {
  canonicalDocumentClaims,
  canonicalDocumentMode,
  canonicalDocumentRetirements,
  canonicalOwnedDirectories,
} from "./task-event-store-claims-layout.ts";
import { canonicalLedgerCut } from "./task-event-store-contract.ts";
import { resolveLedgerGitLayout, ledgerGitPath } from "./ledger-git-layout.ts";
import { localGitObjectRefStore, localGitWorktreeSettlement } from "./local-version-control-system.ts";
import { openSqliteEventStore } from "./sqlite-event-store.ts";
import type { SqliteEventStore } from "./sqlite-event-store.ts";
import type { PublicationFile, PublicationWrite, PublicationDelete } from "./task-event-store-types.ts";
import { TaskEventStoreError } from "./task-event-store-types.ts";
import { finalizeRefs, prepareCommit } from "./task-event-store-git-refs.ts";

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

export function publishConvertedGeneration(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly repoId: string;
  readonly store: SqliteEventStore;
  readonly authoredBranch?: string;
}): { readonly commitSha: string; readonly revision: number; readonly changed: boolean } {
  const ledger = resolveLedgerGitLayout(input.rootInput),
    branch = input.authoredBranch ?? localGitObjectRefStore.currentBranch(ledger.rootDir);
  if (!branch) throw new TaskEventStoreError("publication_indeterminate", "authored branch is detached");
  const authoredRef = `refs/heads/${branch}`,
    parent = localGitObjectRefStore.resolveCommit(ledger.rootDir, authoredRef),
    revision = input.store.revision();
  if (revision === 0) return { commitSha: parent, revision, changed: false };
  const event = input.store.eventAtRevision(revision),
    cut = canonicalLedgerCut(input.repoId, event ? eventHead(event) : null),
    closureEvents = readEventsThrough(input.store, revision),
    files = [
      ...followerFiles(ledger, closureEvents, input.store.readContentObject, cut, input.store.metadata().generation),
      ...legacyRetirements(ledger, parent),
    ],
    directories = followerDirectories(ledger, closureEvents),
    manifestTarget = ledgerGitPath(ledger, followerManifestPath),
    alreadyCertified =
      localGitObjectRefStore.readPath(ledger.rootDir, parent, manifestTarget) !== null &&
      JSON.parse(localGitObjectRefStore.readPath(ledger.rootDir, parent, manifestTarget)!.toString("utf8"))
        .generation === input.store.metadata().generation &&
      certifiedFollowerRevision(ledger, parent, input.store) === revision;
  if (alreadyCertified) {
    const baseline = captureConversionBaseline(input.rootInput, ledger.rootDir, parent, files);
    localGitWorktreeSettlement.index(ledger.rootDir, files);
    if (
      !worktreeMatchesBaseline(ledger.rootDir, baseline, files) ||
      settleWorktree(ledger.rootDir, files, baseline).length > 0
    )
      throw new TaskEventStoreError("publication_indeterminate", "authored worktree has concurrent edits");
    settleWorktreeDirectories(ledger.rootDir, directories);
    return { commitSha: parent, revision, changed: false };
  }
  const tempRef = `refs/ha-sqlite-outbox/${sha256Text(`conversion:${revision}:${cut.headDigest}`)}`,
    commit = prepareCommit(ledger.rootDir, tempRef, parent, files, `conversion-${revision}`, new Date().toISOString()),
    baseline = captureConversionBaseline(input.rootInput, ledger.rootDir, parent, files);
  finalizeRefs(ledger.rootDir, authoredRef, commit, parent, tempRef);
  localGitWorktreeSettlement.index(ledger.rootDir, files);
  if (
    !worktreeMatchesBaseline(ledger.rootDir, baseline, files) ||
    settleWorktree(ledger.rootDir, files, baseline).length > 0
  )
    throw new TaskEventStoreError("publication_indeterminate", "authored worktree has concurrent edits");
  settleWorktreeDirectories(ledger.rootDir, directories);
  return { commitSha: commit, revision, changed: true };
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
    revision = certifiedFollowerRevision(ledger, commitSha, input.store);
  if (revision !== input.store.revision())
    throw new TaskEventStoreError("publication_indeterminate", "Git follower does not certify the current SQLite cut");
  const event = input.store.eventAtRevision(revision),
    cut = canonicalLedgerCut(input.repoId, event ? eventHead(event) : null),
    closure = documentClosure(readEventsThrough(input.store, revision));
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

const followerManifestPath = "events/segments/manifest.json";

/** The publication of `events`: their documents' latest bytes, their retirements, and last the cut's manifest. */
export function followerFiles(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  events: readonly CanonicalEventV1[],
  readContent: (sha256: string) => Uint8Array | null,
  cut: LedgerCutIdentity,
  generation: number,
): (PublicationWrite | PublicationDelete)[] {
  const latest = new Map<string, { body: Uint8Array; mode: "100644" | "120000" }>(),
    retired = new Set<string>();
  for (const event of events) {
    for (const retirement of canonicalDocumentRetirements(event)) {
      latest.delete(retirement.path);
      retired.add(retirement.path);
    }
    for (const claim of canonicalDocumentClaims(event)) {
      const bytes = readContent(claim.sha256);
      if (!bytes || bytes.byteLength !== claim.size || sha256Bytes(bytes) !== claim.sha256)
        throw new TaskEventStoreError("invalid_store", `content object ${claim.sha256} is missing or corrupt`);
      latest.set(claim.path, {
        body: bytes,
        mode: canonicalDocumentMode(event, claim.path),
      });
      retired.delete(claim.path);
    }
  }
  return [
    ...[...latest].map(([target, value]) => ({ target: ledgerGitPath(ledger, target), ...value })),
    ...[...retired].map((target) => ({ delete: ledgerGitPath(ledger, target) })),
    { target: ledgerGitPath(ledger, followerManifestPath), body: followerManifest(generation, cut), mode: "100644" },
  ];
}

function followerManifest(generation: number, cut: LedgerCutIdentity): string {
  return `${JSON.stringify({ schema: "sqlite-ledger-segment-manifest/v1", generation, cut })}\n`;
}

/** Pre-SQLite paths the index tracks, and with a `parent`, its tree holds: conversion retires both. */
export function legacyRetirements(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  parent: string | null,
): PublicationDelete[] {
  const scopes = [ledgerGitPath(ledger, "events/"), ledgerGitPath(ledger, "objects/sha256/")],
    retired = new Set(localGitWorktreeSettlement.indexedPaths(ledger.rootDir, scopes));
  if (parent !== null)
    for (const entry of localGitObjectRefStore.listTree(ledger.rootDir, parent, scopes)) retired.add(entry.target);
  retired.delete(ledgerGitPath(ledger, followerManifestPath));
  return [...retired].map((target) => ({ delete: target }));
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
): FollowerDirectorySettlement {
  const declaredByOwner = new Map<string, readonly string[]>(),
    retiredByOwner = new Map<string, readonly string[]>();
  for (const event of events) {
    const owned = canonicalOwnedDirectories(event);
    if (!owned) continue;
    declaredByOwner.set(owned.ownerRef, owned.directories);
    retiredByOwner.set(owned.ownerRef, owned.retirements);
  }
  const create = [...new Set([...declaredByOwner.values()].flat())]
      .map((logical) => ledgerGitPath(ledger, logical))
      .sort(),
    held = new Set(create);
  return {
    create,
    // Reverse path order is depth order: `a/b/c` sorts after `a/b`, which sorts after `a`.
    retire: [...new Set([...retiredByOwner.values()].flat())]
      .map((logical) => ledgerGitPath(ledger, logical))
      .filter((directory) => !held.has(directory))
      .sort()
      .reverse(),
  };
}

export function settleWorktreeDirectories(repoRoot: string, settlement: FollowerDirectorySettlement): void {
  if (settlement.create.length > 0)
    localGitWorktreeSettlement.visible(
      repoRoot,
      settlement.create.map((directory) => ({ directory })),
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
  const preserved = new Set(localGitWorktreeSettlement.retireEmptyDirectories(repoRoot, settlement.retire));
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
export function certifiedFollowerRevision(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  commit: string,
  sqlite: ReturnType<typeof openSqliteEventStore>,
): number {
  const bytes = localGitObjectRefStore.readPath(ledger.rootDir, commit, ledgerGitPath(ledger, followerManifestPath));
  return bytes ? manifestRevision(bytes, sqlite) : 0;
}

/** The revision the worktree's own manifest names, or 0 (settle the whole closure) when it names no SQLite cut. */
export function physicalWorktreeRevision(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  sqlite: ReturnType<typeof openSqliteEventStore>,
): number {
  const node = localGitWorktreeSettlement.readNode(`${ledger.rootDir}/${ledgerGitPath(ledger, followerManifestPath)}`);
  if (node?.mode !== "100644") return 0;
  try {
    return manifestRevision(node.bytes, sqlite);
  } catch (error) {
    consumeKnownError(error);
    return 0;
  }
}

function manifestRevision(bytes: Buffer, sqlite: ReturnType<typeof openSqliteEventStore>): number {
  const parsed = decodeFollowerManifest(bytes),
    revision = Number(parsed.cut?.revision);
  if (
    parsed.generation !== sqlite.metadata().generation ||
    parsed.cut?.repoId !== sqlite.metadata().repoId ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    revision > sqlite.revision()
  )
    throw new TaskEventStoreError("publication_indeterminate", "Git follower manifest identity is invalid");
  const event = sqlite.eventAtRevision(revision),
    expected = canonicalLedgerCut(sqlite.metadata().repoId, event ? eventHead(event) : null);
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
  const event = sqlite.eventAtRevision(revision),
    held = new Map(
      [...documentClosure(event ? readEventsThrough(sqlite, revision) : []).documents].map(([logical, document]) => [
        ledgerGitPath(ledger, logical),
        `${document.mode}:${document.sha256}:${document.size}`,
      ]),
    );
  if (event) {
    const manifest = followerManifest(
      sqlite.metadata().generation,
      canonicalLedgerCut(sqlite.metadata().repoId, eventHead(event)),
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

function eventHead(event: CanonicalEventV1): EventHead {
  return {
    revision: event.workspaceRevision,
    opId: event.opId,
    eventDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(event))}`,
  };
}

export function readEventsThrough(
  sqlite: ReturnType<typeof openSqliteEventStore>,
  revision: number,
): readonly CanonicalEventV1[] {
  return readPendingEvents(sqlite, 0).filter((event) => event.workspaceRevision <= revision);
}

export function readPendingEvents(
  sqlite: ReturnType<typeof openSqliteEventStore>,
  revision: number,
): readonly CanonicalEventV1[] {
  const events: CanonicalEventV1[] = [];
  let cursor = revision;
  for (;;) {
    const page = sqlite.eventsAfter(cursor);
    events.push(...page);
    if (page.length < 4096) return events;
    cursor = page.at(-1)!.workspaceRevision;
  }
}

function documentClosure(events: readonly CanonicalEventV1[]): {
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
  repoRoot: string,
  files: readonly PublicationFile[],
  baseline: ReadonlyMap<string, string>,
  killpoint?: (point: import("./task-event-store-types.ts").EventPublicationKillpoint) => void,
  preserve: ReadonlySet<string> = new Set(),
  commit = "",
): readonly string[] {
  const deletes = files.flatMap((file) => ("delete" in file ? [file.delete] : [])),
    writes = files.flatMap((file) => ("target" in file ? [file] : [])),
    conflicts: string[] = [];
  for (const target of deletes)
    if (
      !settleVisibleChange(repoRoot, target, "missing", baseline, killpoint, (hooks) =>
        localGitWorktreeSettlement.deleteVisible(repoRoot, [target], hooks),
      )
    )
      conflicts.push(target);
  for (const file of writes)
    if (
      !settleVisibleChange(
        repoRoot,
        file.target,
        `${file.mode}:${publicationDigest(file.body)}:${Buffer.byteLength(file.body)}`,
        baseline,
        killpoint,
        (hooks) => {
          if (preserve.has(file.target)) {
            hooks.beforeRename();
            const node = localGitWorktreeSettlement.readNode(`${repoRoot}/${file.target}`);
            if (node && node.sha256 !== publicationDigest(file.body))
              localGitWorktreeSettlement.preserveVisibleConflict(
                repoRoot,
                `${repoRoot}/${file.target}`,
                file.target,
                commit,
              );
          }
          localGitWorktreeSettlement.visible(repoRoot, [file], hooks);
        },
      )
    )
      conflicts.push(file.target);
  return conflicts;
}

function settleVisibleChange(
  repoRoot: string,
  target: string,
  settled: string,
  baseline: ReadonlyMap<string, string>,
  killpoint: ((point: import("./task-event-store-types.ts").EventPublicationKillpoint) => void) | undefined,
  apply: (hooks: { readonly beforeRename: () => void; readonly afterRename: () => void }) => void,
): boolean {
  let changed = false;
  const conflict = new Error("authored worktree changed during settlement");
  try {
    const hooks = {
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
  const baseline = new Map(captureGitBaseline(repoRoot, parent, files));
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
      ? localGitWorktreeSettlement.preserveConflict(repoRoot, `${repoRoot}/${target}`, target, parent)
      : null;
    if (node && localGitWorktreeSettlement.readNode(`${repoRoot}/${preservedPath}`)?.sha256 !== node.sha256)
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

export function captureGitBaseline(
  repoRoot: string,
  commit: string,
  files: readonly PublicationFile[],
): ReadonlyMap<string, string> {
  const targets = files.flatMap((file) => {
      const target = "target" in file ? file.target : "delete" in file ? file.delete : null;
      return target === null ? [] : [target];
    }),
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

export function worktreeFingerprint(node: ReturnType<typeof localGitWorktreeSettlement.readNode>): string {
  return node === null ? "missing" : `${node.mode}:${node.sha256}:${node.size}`;
}
