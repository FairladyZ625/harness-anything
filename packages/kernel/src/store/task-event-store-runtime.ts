import { isTaskEvent, ledgerCommitSha, type CanonicalEventV1 } from "../domain/doc-sync.contract.ts";
import { type EventHead } from "../domain/write-chain.contract.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import { type LedgerLayoutState } from "../layout/ledger-object-layout.ts";
import { resolveLedgerGitLayout } from "./ledger-git-layout.ts";
import type { EventPublicationKillpoint } from "./task-event-store-types.ts";
import { CANONICAL_EVENT_REF, TaskEventStoreError } from "./task-event-store-types.ts";
import { currentBranch, publicationRefs, updateRef } from "./task-event-store-git-refs.ts";
import { readBlobAt, readEventAt, readHeadAt } from "./task-event-store-reads.ts";

// Per-store mutable state and cache-preserving canonical stream accessors.
export function createStoreRuntime(options: {
  readonly repoId: string;
  readonly rootInput?: HarnessLayoutInput;
  readonly rootDir?: string;
  readonly authoredBranch?: string;
  readonly killpoint?: (point: EventPublicationKillpoint) => void;
  readonly beforeAppend?: () => void;
  readonly withAppendFence?: <T>(operation: () => T) => T;
  readonly rejectPreparedRecovery?: boolean;
}) {
  const input = options.rootInput ?? options.rootDir;
  if (input === undefined) throw new Error("canonical event store requires rootInput or rootDir");
  const layout = resolveHarnessLayout(input);
  const ledger = resolveLedgerGitLayout(input);
  const repoRoot = ledger.rootDir;
  const repoId = ledgerCommitSha(options.repoId, "0".repeat(40)).repoId;
  const authoredBranch = options.authoredBranch ?? currentBranch(repoRoot);
  const authoredRef = `refs/heads/${authoredBranch}`;
  const refs = publicationRefs(repoRoot, authoredRef);
  if (!refs.authored)
    throw new TaskEventStoreError("publication_indeterminate", "registered authored branch cannot be resolved");
  let authoredCommit = refs.authored;
  let canonicalCommit = refs.canonical ?? authoredCommit;
  let canonicalHead: EventHead | null | undefined;
  let initialPrepared: readonly (readonly [string, string])[] | null = refs.prepared;
  let recentContent = new Map<string, Uint8Array>();
  const recentEvents = new Map<string, CanonicalEventV1>();
  let knownOpIds: Set<string> | null = null;
  let layoutState: LedgerLayoutState | undefined;
  if (!refs.canonical) updateRef(repoRoot, CANONICAL_EVENT_REF, canonicalCommit);
  const currentCommit = () => ledgerCommitSha(repoId, canonicalCommit);
  const readHead = () => {
    if (canonicalHead === undefined) canonicalHead = readHeadAt(ledger, canonicalCommit);
    if (canonicalHead === null && knownOpIds === null) knownOpIds = new Set();
    return canonicalHead;
  };
  const rememberEvents = (events: readonly CanonicalEventV1[]): void => {
    for (const event of events) {
      recentEvents.set(event.opId, event);
      knownOpIds?.add(event.opId);
    }
  };
  const readEvent = (opId: string) => {
    const recent = recentEvents.get(opId);
    if (recent !== undefined) return recent;
    if (knownOpIds !== null && !knownOpIds.has(opId)) return null;
    const event = readEventAt(ledger, canonicalCommit, opId);
    if (event !== null) rememberEvents([event]);
    return event;
  };
  const readTaskEvent = (opId: string) => {
    const event = readEvent(opId);
    return event !== null && isTaskEvent(event) ? event : null;
  };
  const readContentBlob = (sha256: string) => recentContent.get(sha256) ?? readBlobAt(ledger, canonicalCommit, sha256);
  return {
    options,
    layout,
    ledger,
    repoRoot,
    repoId,
    authoredRef,
    get authoredCommit() {
      return authoredCommit;
    },
    set authoredCommit(value: string) {
      authoredCommit = value;
    },
    get canonicalCommit() {
      return canonicalCommit;
    },
    set canonicalCommit(value: string) {
      canonicalCommit = value;
    },
    get canonicalHead() {
      return canonicalHead;
    },
    set canonicalHead(value: EventHead | null | undefined) {
      canonicalHead = value;
    },
    get initialPrepared() {
      return initialPrepared;
    },
    set initialPrepared(value: readonly (readonly [string, string])[] | null) {
      initialPrepared = value;
    },
    get recentContent() {
      return recentContent;
    },
    set recentContent(value: Map<string, Uint8Array>) {
      recentContent = value;
    },
    recentEvents,
    get knownOpIds() {
      return knownOpIds;
    },
    set knownOpIds(value: Set<string> | null) {
      knownOpIds = value;
    },
    get layoutState() {
      return layoutState;
    },
    set layoutState(value: LedgerLayoutState | undefined) {
      layoutState = value;
    },
    currentCommit,
    readHead,
    rememberEvents,
    readEvent,
    readTaskEvent,
    readContentBlob,
  };
}
export type StoreRuntime = ReturnType<typeof createStoreRuntime>;
