import { isTaskEvent, ledgerCommitSha, type CanonicalEventV1 } from "../domain/doc-sync.contract.ts";
import { isTaskBootstrapEvent } from "../domain/task-bootstrap-event.ts";
import type { LedgerCutIdentity } from "../domain/write-chain.contract.ts";
import { ledgerAuthoredPath, ledgerGitPath, type LedgerGitLayout } from "./ledger-git-layout.ts";
import { localGitObjectRefStore, localGitWorktreeSettlement } from "./local-version-control-system.ts";
import { openSqliteEventStore } from "./sqlite-event-store.ts";
import {
  captureGitBaseline,
  followerFiles,
  legacyRetirements,
  ledgerWorktreeBaseline,
  physicalWorktreeRevision,
  publicationDigest,
  readPendingEvents,
  settleVisibleChange,
  worktreeFingerprint,
} from "./sqlite-task-event-publication.ts";
import {
  TaskEventStoreError,
  type EventPublicationKillpoint,
  type MaterializationReceipt,
  type MaterializationSettlement,
  type PublicationDelete,
  type PublicationWrite,
} from "./task-event-store-types.ts";

/** The live store state the operator-facing materialize requests read and settle through. */
export interface MaterializeStoreContext {
  readonly repoId: string;
  readonly killpoint?: (point: EventPublicationKillpoint) => void;
  readonly cut: () => LedgerCutIdentity;
  readonly ledger: () => LedgerGitLayout;
  readonly authoredRef: () => string;
  readonly sqlite: ReturnType<typeof openSqliteEventStore>;
  readonly readContent: (sha256: string) => Uint8Array | null;
  readonly acceptedWorktree: Map<string, { readonly fingerprint: string; readonly preserve: boolean }>;
  readonly worktreeConflicts: Map<string, string>;
  readonly settledWorktreeRevision: () => number | null;
}

/**
 * The classification a whole-closure pass settles by: what it would overwrite — keeping the operator's bytes as
 * conflict copies for targets an accepted event laid down — what it would recreate because it is missing, and what
 * it must leave to a concurrent local edit. The settling pass and the preview share it, so a preview cannot drift
 * from the pass it previews.
 */
export function planFollowerSettlement(
  acceptedWorktree: ReadonlyMap<string, { readonly fingerprint: string; readonly preserve: boolean }>,
  currentLedger: LedgerGitLayout,
  files: readonly (PublicationWrite | PublicationDelete)[],
  baseline: ReadonlyMap<string, string>,
  restoreMissing: boolean,
): {
  readonly eligible: readonly (PublicationWrite | PublicationDelete)[];
  readonly conflicts: readonly string[];
  readonly preserve: ReadonlySet<string>;
  readonly missing: ReadonlySet<string>;
  readonly permitted: ReadonlyMap<string, string>;
} {
  const permitted = new Map(baseline),
    preserve = new Set<string>(),
    missing = new Set<string>(),
    conflicts: string[] = [];
  for (const [logical, accepted] of acceptedWorktree) {
    const target = ledgerGitPath(currentLedger, logical);
    if (
      !baseline.has(target) ||
      worktreeFingerprint(localGitWorktreeSettlement.readNode(`${currentLedger.rootDir}/${target}`)) !==
        accepted.fingerprint
    )
      continue;
    permitted.set(target, accepted.fingerprint);
    if (accepted.preserve && baseline.get(target) !== accepted.fingerprint) preserve.add(target);
  }
  const eligible = files.filter((file) => {
    const target = "target" in file ? file.target : file.delete,
      current = worktreeFingerprint(localGitWorktreeSettlement.readNode(`${currentLedger.rootDir}/${target}`));
    if (current === "missing" && (restoreMissing || !permitted.has(target))) permitted.set(target, "missing");
    if (current === settledFingerprint(file)) return false;
    if (current === permitted.get(target)) {
      if (current === "missing") missing.add(target);
      return true;
    }
    conflicts.push(target);
    return false;
  });
  return { eligible, conflicts, preserve, missing, permitted };
}

/**
 * Receipt rows for the targets a plan settled (or, for a preview, would settle); the manifest is
 * bookkeeping, not a document.
 */
export function settlementRows(
  currentLedger: LedgerGitLayout,
  plan: ReturnType<typeof planFollowerSettlement>,
  settled: ReadonlySet<string>,
  copies: ReadonlyMap<string, string>,
): readonly MaterializationSettlement[] {
  return plan.eligible.flatMap((file) => {
    const target = "target" in file ? file.target : file.delete;
    if (!settled.has(target) || target === ledgerGitPath(currentLedger, "events/segments/manifest.json")) return [];
    return [
      {
        path: ledgerAuthoredPath(currentLedger, target),
        action: plan.missing.has(target)
          ? ("restore" as const)
          : "target" in file
            ? ("overwrite" as const)
            : ("delete" as const),
        copy: copies.has(target) ? ledgerAuthoredPath(currentLedger, copies.get(target)!) : null,
      },
    ];
  });
}

/** What a whole-closure materialize would touch right now: the plan of the pass `--all` runs, without writing. */
export function previewMaterialization(context: MaterializeStoreContext): MaterializationReceipt {
  const accepted = context.cut(),
    currentLedger = context.ledger(),
    parent = localGitObjectRefStore.resolveCommit(currentLedger.rootDir, context.authoredRef());
  if (accepted.revision === 0)
    return {
      status: "planned",
      commitSha: ledgerCommitSha(context.repoId, parent),
      settlements: [],
      conflicts: [],
    };
  const worktreeRevision = context.settledWorktreeRevision() ?? physicalWorktreeRevision(currentLedger, context.sqlite),
    // A generation converted before the index followed Git can still index pre-SQLite paths: the same
    // retirements a whole-closure pass settles, so the preview does not drift from the pass it previews.
    legacy = context.settledWorktreeRevision() === null ? legacyRetirements(currentLedger, null) : [],
    events = readPendingEvents(context.sqlite, 0),
    files = [
      ...followerFiles(currentLedger, events, context.readContent, accepted, context.sqlite.metadata().generation),
      ...legacy,
    ],
    baseline = new Map(captureGitBaseline(currentLedger.rootDir, parent, files));
  // The same last-held patch a restore-missing pass applies, so the preview classifies the bytes the pass would.
  const held = new Map([
    ...ledgerWorktreeBaseline(currentLedger, context.sqlite, worktreeRevision, files),
    ...recoverGeneratedWorktreeBaseline(currentLedger, events),
  ]);
  for (const [target, previous] of held)
    if (
      worktreeFingerprint(localGitWorktreeSettlement.readNode(`${currentLedger.rootDir}/${target}`)) !==
      baseline.get(target)
    )
      baseline.set(target, previous);
  const plan = planFollowerSettlement(context.acceptedWorktree, currentLedger, files, baseline, true);
  return {
    status: "planned",
    commitSha: ledgerCommitSha(context.repoId, parent),
    settlements: settlementRows(
      currentLedger,
      plan,
      new Set(plan.eligible.map((file) => ("target" in file ? file.target : file.delete))),
      new Map(),
    ),
    conflicts: [...new Set([...plan.conflicts, ...context.worktreeConflicts.keys()])]
      .sort()
      .map((target) => ledgerAuthoredPath(currentLedger, target)),
  };
}

/**
 * Restores the named documents to their canonical bytes, keeping the operator's current bytes beside them as a
 * conflict copy: the path-by-path selection an operator confirmed explicitly. Retired paths are refused — the
 * canonical cut holds no document to restore there — and unknown paths likewise.
 */
export function restoreRequestedDocuments(
  context: MaterializeStoreContext,
  logicals: readonly string[],
): MaterializationReceipt {
  const accepted = context.cut(),
    currentLedger = context.ledger(),
    parent = localGitObjectRefStore.resolveCommit(currentLedger.rootDir, context.authoredRef());
  if (accepted.revision === 0)
    throw new TaskEventStoreError("invalid_store", "no accepted ledger cut exists to restore from");
  const events = readPendingEvents(context.sqlite, 0),
    canonical = new Map(
      followerFiles(currentLedger, events, context.readContent, accepted, context.sqlite.metadata().generation).flatMap(
        (file) => ("target" in file ? [[ledgerAuthoredPath(currentLedger, file.target), file] as const] : []),
      ),
    ),
    settlements: MaterializationSettlement[] = [],
    conflicts: string[] = [],
    written: PublicationWrite[] = [];
  for (const logical of logicals) {
    const file = canonical.get(logical);
    if (!file || !("target" in file))
      throw new TaskEventStoreError("invalid_write_plan", `canonical holds no restorable document at ${logical}`);
    const target = file.target,
      settled = settledFingerprint(file),
      entry = worktreeFingerprint(localGitWorktreeSettlement.readNode(`${currentLedger.rootDir}/${target}`));
    if (entry === settled) continue;
    let copy: string | null = null;
    const restored = settleVisibleChange(
      currentLedger.rootDir,
      target,
      settled,
      new Map([[target, entry]]),
      context.killpoint,
      (hooks) => {
        const node = localGitWorktreeSettlement.readNode(`${currentLedger.rootDir}/${target}`);
        if (node && node.sha256 !== publicationDigest(file.body)) {
          hooks.beforeRename();
          copy = localGitWorktreeSettlement.preserveVisibleConflict(
            currentLedger.rootDir,
            `${currentLedger.rootDir}/${target}`,
            target,
            accepted.headDigest,
          );
        }
        localGitWorktreeSettlement.visible(currentLedger.rootDir, [file], hooks);
      },
    );
    if (!restored) {
      conflicts.push(logical);
      continue;
    }
    written.push(file);
    settlements.push({
      path: logical,
      action: entry === "missing" ? "restore" : "overwrite",
      copy: copy === null ? null : ledgerAuthoredPath(currentLedger, copy),
    });
    context.worktreeConflicts.delete(target);
    context.acceptedWorktree.delete(logical);
  }
  if (written.length > 0) localGitWorktreeSettlement.index(currentLedger.rootDir, written);
  return {
    status: "visible",
    commitSha: ledgerCommitSha(context.repoId, parent),
    settlements,
    conflicts,
  };
}

/**
 * A machine-written file the window restates may still hold any earlier snapshot of it that an interrupted pass
 * left.
 */
export function recoverGeneratedWorktreeBaseline(
  ledger: LedgerGitLayout,
  events: readonly CanonicalEventV1[],
): ReadonlyMap<string, string> {
  const recovered = new Map<string, string>(),
    observed = new Map<string, string>();
  for (const event of events) {
    const claims = isTaskEvent(event)
      ? (event.payload.documentClaims ?? [])
      : isTaskBootstrapEvent(event)
        ? event.payload.initialDocumentClaims
        : [];
    for (const claim of claims) {
      if (claim.policyId !== "typed-machine-writer/v1") continue;
      const target = ledgerGitPath(ledger, claim.path),
        fingerprint = `100644:${claim.sha256}:${claim.size}`;
      if (!observed.has(target))
        observed.set(target, worktreeFingerprint(localGitWorktreeSettlement.readNode(`${ledger.rootDir}/${target}`)));
      if (observed.get(target) === fingerprint) recovered.set(target, fingerprint);
    }
  }
  return recovered;
}

export function settledFingerprint(file: PublicationWrite | PublicationDelete): string {
  return "target" in file ? `${file.mode}:${publicationDigest(file.body)}:${Buffer.byteLength(file.body)}` : "missing";
}
