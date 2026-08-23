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
import type { CanonicalEventStore } from "./task-event-store-types.ts";
import { CANONICAL_EVENT_REF, TaskEventStoreError } from "./task-event-store-types.ts";
import { createStoreRuntime, type StoreRuntime } from "./task-event-store-runtime.ts";
import { createPublicationApi } from "./task-event-store-publication.ts";
import {
  canonicalEventCut,
  canonicalLedgerCut,
  canonicalRevisionAt,
  readBatch,
  readStream,
} from "./task-event-store-reads.ts";
import { cachedBatchEventEntries, scanEventsRoot } from "./task-event-store-layout.ts";
import { materialize } from "./task-event-store-materialization.ts";

// Public event-store factory that composes runtime state, reading, and publication roles.
export function makeTaskEventStore(options: Parameters<typeof createStoreRuntime>[0]): CanonicalEventStore {
  const runtime = createStoreRuntime(options),
    publication = createPublicationApi(runtime);
  return storeApi(runtime, publication);
}
function storeApi(runtime: StoreRuntime, publication: ReturnType<typeof createPublicationApi>): CanonicalEventStore {
  return {
    canonicalRef: CANONICAL_EVENT_REF,
    currentCommit: runtime.currentCommit,
    currentCut: () => canonicalLedgerCut(runtime.repoId, runtime.readHead()),
    publication: (event) => ({
      commitSha: runtime.currentCommit(),
      cut: canonicalEventCut(runtime.repoId, event),
    }),
    readHead: runtime.readHead,
    readEvent: runtime.readEvent,
    readTaskEvent: runtime.readTaskEvent,
    readContentBlob: runtime.readContentBlob,
    layout: () => {
      if (runtime.layoutState === undefined) {
        const scan = scanEventsRoot(runtime.ledger, runtime.canonicalCommit);
        runtime.layoutState =
          scan !== null && scan.flat.length > 0
            ? scan.shards.length > 0
              ? "mixed"
              : "flat/v1"
            : "sharded-sha256-2/v1";
      }
      return runtime.layoutState;
    },
    revisionAt: (commit) => {
      if (commit.repoId !== runtime.repoId)
        throw new TaskEventStoreError(
          "repo_mismatch",
          `ledger commit belongs to repo ${commit.repoId}, not ${runtime.repoId}`,
        );
      return canonicalRevisionAt(runtime.ledger, runtime.canonicalCommit, commit.sha);
    },
    read: () => {
      const stream = readStream(runtime.ledger, runtime.canonicalCommit, runtime.readHead());
      runtime.knownOpIds = new Set(stream.events.map((event) => event.opId));
      runtime.rememberEvents(stream.events);
      return stream;
    },
    readBatch: (cursor, maxItems) => {
      const batch = readBatch(runtime.ledger, runtime.canonicalCommit, runtime.readHead(), cursor, maxItems);
      runtime.knownOpIds = new Set(
        cachedBatchEventEntries(runtime.ledger, runtime.canonicalCommit).map((entry) =>
          path.posix.basename(entry.name).slice(0, -5),
        ),
      );
      runtime.rememberEvents(batch.events);
      return batch;
    },
    materialize: () =>
      materialize(runtime.ledger, runtime.repoId, runtime.canonicalCommit, runtime.readHead(), runtime.authoredRef),
    append: (bundle) => publication.publish(bundle),
    migrateLayout: publication.migrateLayout,
    recover: publication.recover,
    drain: async () => {},
  };
}
