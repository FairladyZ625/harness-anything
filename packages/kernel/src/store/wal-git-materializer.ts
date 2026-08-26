import { serializePersistedCanonicalEvent } from "../domain/doc-sync.contract.ts";
import { serializeEventHead } from "../domain/write-chain.contract.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import {
  contentObjectRelativePath,
  eventObjectRelativePath,
  type LedgerObjectLayout,
} from "../layout/ledger-object-layout.ts";
import { ledgerGitPath, resolveLedgerGitLayout } from "./ledger-git-layout.ts";
import { localGitObjectRefStore, localGitWorktreeSettlement } from "./local-version-control-system.ts";
import {
  canonicalDocumentClaims,
  canonicalDocumentMode,
  canonicalDocumentRetirements,
  TaskEventStoreError,
  type CanonicalEventStore,
  type EventPublicationKillpoint,
} from "./task-event-store.ts";
import type { WalEventLog, WalEventRecord } from "./wal-event-log.ts";

export interface WalGitMaterializerOptions {
  readonly rootInput?: HarnessLayoutInput;
  readonly rootDir?: string;
  readonly authoredBranch?: string;
  readonly killpoint?: (point: EventPublicationKillpoint) => void;
  readonly withAppendFence?: <T>(operation: () => T) => T;
}

/** The authored branch moved independently of the canonical daemon cut. */
export class WalMaterializerDivergedError extends TaskEventStoreError {
  readonly canonicalSha: string;

  constructor(repoRoot: string, authoredRef: string, canonicalSha: string) {
    super(
      "publication_indeterminate",
      [
        `authored ref ${authoredRef} diverged from the canonical event cut ${canonicalSha}.`,
        `Repair with: git -C ${repoRoot} reset ${canonicalSha}`,
        "then retry materialization.",
      ].join(" "),
    );
    this.name = "WalMaterializerDivergedError";
    this.canonicalSha = canonicalSha;
  }
}

export function flushWalToGit(wal: WalEventLog, git: CanonicalEventStore, options: WalGitMaterializerOptions): void {
  const records = wal.records();
  if (records.length === 0) return;
  const input = options.rootInput ?? options.rootDir;
  if (input === undefined) throw new Error("canonical event store requires rootInput or rootDir");
  const ledger = resolveLedgerGitLayout(input);
  cleanFlushRefs(ledger.rootDir);
  const through = git.readHead()?.revision ?? 0;
  for (const record of records.filter((candidate) => candidate.revision <= through)) {
    const durable = git.readEvent(record.opId);
    if (durable === null || canonicalBytes(durable) !== canonicalBytes(record.event))
      throw new TaskEventStoreError(
        "invalid_store",
        `WAL revision ${record.revision} differs from its materialized Git event`,
      );
  }
  const pending = records.filter((record) => record.revision > through);
  const settlementRecords = pending.length === 0 ? records : pending;
  const layoutState = git.layout();
  if (layoutState === "mixed")
    throw new TaskEventStoreError("invalid_store", "cannot flush WAL into a mixed Git layout");
  const files = batchFiles(wal, ledger, settlementRecords, layoutState);
  const documentTargets = new Set(
    settlementRecords.flatMap((record) => [
      ...canonicalDocumentClaims(record.event).map((claim) => ledgerGitPath(ledger, claim.path)),
      ...canonicalDocumentRetirements(record.event).map((retirement) => ledgerGitPath(ledger, retirement.path)),
    ]),
  );
  const documentFiles = files.filter((file) => documentTargets.has("delete" in file ? file.delete : file.target));
  const durableFiles = files.filter((file) => !documentTargets.has("delete" in file ? file.delete : file.target));
  if (pending.length === 0) {
    localGitWorktreeSettlement.settle(ledger.rootDir, durableFiles);
    localGitWorktreeSettlement.index(ledger.rootDir, documentFiles);
    wal.checkpoint(records.at(-1)!.revision);
    return;
  }
  for (const [index, record] of pending.entries())
    if (record.revision !== through + index + 1)
      throw new TaskEventStoreError(
        "revision_conflict",
        `WAL revision ${record.revision} is not contiguous after Git revision ${through}`,
      );
  const last = pending.at(-1)!;
  const parent = git.currentCommit().sha;
  const branch = options.authoredBranch ?? localGitObjectRefStore.currentBranch(ledger.rootDir);
  if (!branch)
    throw new TaskEventStoreError(
      "publication_indeterminate",
      "authored branch is detached; register a default branch before flushing WAL",
    );
  const authoredRef = `refs/heads/${branch}`;
  const liveRefs = new Map(
    localGitObjectRefStore
      .listRefs(ledger.rootDir, ["refs/ha/canonical", authoredRef])
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        const [ref, sha] = line.split(" ");
        return [ref!, sha!] as const;
      }),
  );
  const canonicalParent = liveRefs.get("refs/ha/canonical");
  const authoredParent = liveRefs.get(authoredRef);
  if (canonicalParent !== parent || authoredParent === undefined)
    throw new TaskEventStoreError(
      "publication_indeterminate",
      "Git refs changed while preparing the WAL materialization batch",
    );
  if (authoredParent !== parent && !localGitObjectRefStore.isAncestor(ledger.rootDir, parent, authoredParent))
    throw new WalMaterializerDivergedError(ledger.rootDir, authoredRef, parent);
  const flushRef = `refs/ha-wal-flush/${process.pid}-${Date.now()}`;
  const messageText = `harness WAL flush ${pending[0]!.revision}-${last.revision}`;
  const timestamp = Math.floor(Date.parse(last.event.occurredAt) / 1_000);
  let inputText = `commit ${flushRef}\nmark :1\ncommitter Harness WAL <harness-wal@local.invalid> ${timestamp} +0000\ndata ${Buffer.byteLength(messageText)}\n${messageText}\nfrom ${authoredParent}\n`;
  for (const file of files)
    inputText +=
      "delete" in file
        ? `D ${file.delete}\n`
        : `M ${file.mode ?? "100644"} inline ${file.target}\ndata ${Buffer.byteLength(file.body)}\n${file.body}\n`;
  inputText += "\nget-mark :1\ndone\n";
  const imported =
    localGitObjectRefStore.importCommit(ledger.rootDir, inputText).toString("utf8").trim().split("\n").at(-1) ?? "";
  if (!/^[0-9a-f]{40}$/u.test(imported))
    throw new TaskEventStoreError("publication_indeterminate", "WAL Git flush returned no commit");
  options.killpoint?.("after_git_commit");
  const finalize = (): void =>
    localGitObjectRefStore.updateRefs(
      ledger.rootDir,
      `start\nupdate refs/ha/canonical ${imported} ${parent}\nupdate ${authoredRef} ${imported} ${authoredParent}\nprepare\ncommit\n`,
    );
  try {
    if (options.withAppendFence) options.withAppendFence(finalize);
    else finalize();
    options.killpoint?.("after_git_ref_update");
    localGitWorktreeSettlement.settle(ledger.rootDir, durableFiles);
    localGitWorktreeSettlement.index(ledger.rootDir, documentFiles);
  } finally {
    localGitObjectRefStore.deleteRef(ledger.rootDir, flushRef);
  }
  wal.checkpoint(last.revision);
}

function batchFiles(
  wal: WalEventLog,
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  records: readonly WalEventRecord[],
  layout: LedgerObjectLayout,
): readonly (
  | { readonly target: string; readonly body: string; readonly mode?: "100644" | "120000" }
  | { readonly delete: string }
)[] {
  const files = new Map<
    string,
    | { readonly target: string; readonly body: string; readonly mode?: "100644" | "120000" }
    | { readonly delete: string }
  >();
  const add = (target: string, body: string, mode: "100644" | "120000" = "100644", replace = false): void => {
    const existing = files.get(target);
    if (
      !replace &&
      existing !== undefined &&
      ("delete" in existing || existing.body !== body || existing.mode !== mode)
    )
      throw new TaskEventStoreError("op_conflict", `WAL batch names different bytes at ${target}`);
    files.set(target, { target, body, mode });
  };
  const remove = (target: string): void => {
    files.set(target, { delete: target });
  };
  for (const record of records) {
    add(ledgerGitPath(ledger, eventObjectRelativePath(record.opId, layout)), canonicalBytes(record.event));
    for (const blob of record.blobs)
      add(
        ledgerGitPath(ledger, contentObjectRelativePath(blob.sha256, layout)),
        Buffer.from(requiredWalBlob(wal, blob.sha256)).toString("utf8"),
      );
    for (const retirement of canonicalDocumentRetirements(record.event)) remove(ledgerGitPath(ledger, retirement.path));
    for (const claim of canonicalDocumentClaims(record.event))
      add(
        ledgerGitPath(ledger, claim.path),
        Buffer.from(requiredWalBlob(wal, claim.sha256)).toString("utf8"),
        canonicalDocumentMode(record.event, claim.path),
        true,
      );
  }
  const last = records.at(-1)!;
  add(
    ledgerGitPath(ledger, "events/head.json"),
    serializeEventHead({
      revision: last.revision,
      opId: last.opId,
      eventDigest: `sha256:${sha256Text(canonicalBytes(last.event))}`,
    }),
    "100644",
    true,
  );
  return [...files.values()];
}

function requiredWalBlob(wal: WalEventLog, sha256: string): Uint8Array {
  const bytes = wal.readContentBlob(sha256);
  if (bytes === null) throw new TaskEventStoreError("invalid_store", `WAL content object ${sha256} is missing`);
  return bytes;
}

function cleanFlushRefs(repoRoot: string): void {
  for (const line of localGitObjectRefStore.listRefs(repoRoot, ["refs/ha-wal-flush/"]).trim().split(/\r?\n/u)) {
    const ref = line.split(" ")[0];
    if (ref) localGitObjectRefStore.deleteRef(repoRoot, ref);
  }
}

function canonicalBytes(event: WalEventRecord["event"]): string {
  return serializePersistedCanonicalEvent(event);
}
