import { createHash } from "node:crypto";
import path from "node:path";
import { consumeKnownError } from "../error-consumption.ts";
import { isAgentRuntimeEvent, runtimeEventContentClaims } from "../domain/agent-runtime.ts";
import { assertAgentEntityWritePlan, isAgentEntityEvent } from "../domain/agent-entity-event.ts";
import {
  assertDocSyncWritePlan,
  isDecisionEvent,
  isDocEvent,
  isFactEvent,
  isMigrationImportEvent,
  isTaskEvent,
  ledgerCommitSha,
  parseCanonicalEvent,
  serializeCanonicalEvent,
  validateCurrentCanonicalEvent,
  validateCurrentDocEvent,
  type CanonicalEventV1,
  type DocEventV1,
  type LedgerCommitSha,
} from "../domain/doc-sync.contract.ts";
import {
  assertMigrationImportWritePlan,
  migrationImportClaims,
  migrationImportContentClaims,
} from "../domain/migration-import-event.ts";
import {
  assertLedgerLayoutMigrationWritePlan,
  isLedgerLayoutMigrationEvent,
  ledgerLayoutMigrationWritePlan,
  type LedgerLayoutMigrationEventV1,
} from "../domain/ledger-layout-migration-event.ts";
import { assertDecisionWritePlan } from "../domain/decision-event.ts";
import { assertFactWritePlan } from "../domain/fact-event.ts";
import type { TaskEventV1 } from "../domain/task-lifecycle.contract.ts";
import { assertTaskLifecycleWritePlan } from "../domain/task-lifecycle-publication.ts";
import {
  assertTaskBootstrapWritePlan,
  isTaskBootstrapEvent,
  taskBootstrapClaims,
  type TaskBootstrapEventV1,
} from "../domain/task-bootstrap-event.ts";
import { assertTaskProgressWritePlan, isTaskProgressEvent } from "../domain/task-progress-event.ts";
import {
  assertSnapshotUpgradeInputs,
  isSnapshotUpgradeEvent,
  snapshotUpgradeClaims,
} from "../domain/task-snapshot-upgrade-store-seam.ts";
import {
  freezeDeclaredWritePlan,
  isFrozenWritePlan,
  serializeEventHead,
  type ActorIdentity,
  type EventHead,
  type FrozenWritePlan,
  type LedgerCutIdentity,
  type WriteSource,
  type WriteTarget,
} from "../domain/write-chain.contract.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import {
  assertPublishableOpId,
  contentObjectRelativePath,
  eventObjectRelativePath,
  eventObjectShard,
  eventObjectTarget,
  type LedgerLayoutState,
  type LedgerObjectLayout,
} from "../layout/ledger-object-layout.ts";
import { ledgerGitPath, resolveLedgerGitLayout, type LedgerGitLayout } from "./ledger-git-layout.ts";
import {
  localGitObjectRefStore as gitObjects,
  localGitText,
  localGitWorktreeSettlement as worktree,
} from "./local-version-control-system.ts";
import type { CanonicalEventStore, EventPublicationKillpoint } from "./task-event-store-types.ts";
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
