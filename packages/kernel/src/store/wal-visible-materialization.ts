import { DEFAULT_WAL_FLUSH_SETTINGS } from "../domain/settings.ts";
import { ledgerGitPath, resolveLedgerGitLayout } from "./ledger-git-layout.ts";
import { localGitWorktreeSettlement } from "./local-version-control-system.ts";
import {
  canonicalDocumentClaims,
  canonicalDocumentMode,
  canonicalDocumentRetirements,
  type CanonicalEventStore,
  type CanonicalEventStreamV1,
  type MaterializationReceipt,
} from "./task-event-store.ts";
import type { WalEventLog, WalEventLogProgress } from "./wal-event-log.ts";

interface WalVisibleBaselineNode {
  readonly mode: "100644" | "120000";
  readonly oid: string;
}

export function materializeVisible(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  wal: WalEventLog,
  events: CanonicalEventStreamV1["events"],
  committed: ReadonlyMap<string, WalVisibleBaselineNode>,
  commitSha: ReturnType<CanonicalEventStore["currentCommit"]>,
  readGitContent: (sha256: string) => Uint8Array | null,
  onProgress?: (progress: WalEventLogProgress) => void,
): MaterializationReceipt {
  const latest = latestDocumentClaims(events, onProgress);
  const changed: string[] = [];
  const conflicts: string[] = [];
  const writes: { target: string; body: string; mode: "100644" | "120000" }[] = [];
  const claims = [...latest].sort(([left], [right]) => left.localeCompare(right));
  for (const [index, [logical, claim]] of claims.entries()) {
    const target = ledgerGitPath(ledger, logical);
    const physical = [ledger.rootDir, ...target.split("/")].join("/");
    const local = localGitWorktreeSettlement.readNode(physical);
    // Decide divergence from the worktree hash and the in-memory claim alone; an already-materialized
    // document is skipped before any canonical blob is read. This keeps materialize proportional to the
    // number of divergent files, not the size of the whole corpus: a current worktree reads zero blobs
    // (previously every document forced a `git show`, which wedged the daemon event loop at scale).
    if (local?.sha256 === claim.sha256 && local.mode === claim.mode) {
      reportInspectedClaim(index);
      continue;
    }
    const bytes = wal.readContentBlob(claim.sha256) ?? readGitContent(claim.sha256);
    if (bytes === null) {
      reportInspectedClaim(index);
      continue;
    }
    const base = committed.get(target);
    if (local !== null && (base === undefined || local.gitOid !== base.oid || local.mode !== base.mode))
      conflicts.push(
        localGitWorktreeSettlement.preserveVisibleConflict(
          ledger.rootDir,
          physical,
          target,
          `${events.at(-1)?.workspaceRevision ?? 0}:${claim.sha256}`,
        ),
      );
    changed.push(logical);
    writes.push({ target, body: Buffer.from(bytes).toString("utf8"), mode: claim.mode });
    reportInspectedClaim(index);
  }
  const completedInspection = events.length + claims.length;
  let visibleWrites = 0;
  localGitWorktreeSettlement.visible(ledger.rootDir, writes, {
    afterRename: () => {
      visibleWrites += 1;
      if (visibleWrites % DEFAULT_WAL_FLUSH_SETTINGS.events === 0 || visibleWrites === writes.length)
        onProgress?.({
          applied: completedInspection + visibleWrites,
          total: completedInspection + writes.length,
          watermark: events.at(-1)?.workspaceRevision ?? 0,
        });
    },
  });
  if (writes.length === 0 && completedInspection > 0)
    onProgress?.({
      applied: completedInspection,
      total: completedInspection,
      watermark: events.at(-1)?.workspaceRevision ?? 0,
    });
  return { status: "visible", commitSha, changed, conflicts };

  function reportInspectedClaim(index: number): void {
    const applied = events.length + index + 1;
    if ((index + 1) % DEFAULT_WAL_FLUSH_SETTINGS.events === 0 || index + 1 === claims.length)
      onProgress?.({ applied, watermark: events.at(-1)?.workspaceRevision ?? 0 });
  }
}

export function latestDocumentClaims(
  events: CanonicalEventStreamV1["events"],
  onProgress?: (progress: WalEventLogProgress) => void,
): Map<string, { sha256: string; mode: "100644" | "120000" }> {
  const latest = new Map<string, { sha256: string; mode: "100644" | "120000" }>();
  for (const [index, event] of events.entries()) {
    for (const retirement of canonicalDocumentRetirements(event)) latest.delete(retirement.path);
    for (const claim of canonicalDocumentClaims(event))
      latest.set(claim.path, { sha256: claim.sha256, mode: canonicalDocumentMode(event, claim.path) });
    const applied = index + 1;
    if (applied % DEFAULT_WAL_FLUSH_SETTINGS.events === 0 || applied === events.length)
      onProgress?.({ applied, watermark: event.workspaceRevision });
  }
  return latest;
}
