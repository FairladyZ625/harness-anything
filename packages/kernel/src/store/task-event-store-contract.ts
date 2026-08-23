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
import type { CanonicalWriteBundle } from "./task-event-store-types.ts";
import { assertBundle } from "./task-event-store-validation.ts";
import { contentClaims } from "./task-event-store-claims-layout.ts";

// Public bundle validation and canonical declared-write-plan construction.
export function validateCanonicalWriteBundle(bundle: CanonicalWriteBundle): void {
  assertBundle(bundle);
}
export function canonicalEventContentClaims(event: CanonicalEventV1): readonly {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
}[] {
  return contentClaims(event);
}
export function canonicalEventWritePlan(event: CanonicalEventV1, projection: string, key: string): FrozenWritePlan {
  return freezeDeclaredWritePlan(
    {
      commandType: event.type,
      targets: [
        {
          kind: "event_file",
          path: eventObjectTarget(event.opId),
          operation: "create",
        },
        {
          kind: "event_head",
          path: "harness/events/head.json",
          operation: "replace",
        },
        ...contentClaims(event).map((claim) => ({
          kind: "content_blob" as const,
          sha256: claim.sha256,
          size: claim.size,
          mediaType: claim.mediaType,
        })),
        { kind: "projection_invalidation", projection, key },
      ],
    },
    [event.type],
  );
}
