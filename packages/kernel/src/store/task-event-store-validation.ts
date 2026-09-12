import { assertEntityEventInputs, isEntityEvent } from "../domain/entity-event.ts";
import {
  assertDocSyncWritePlan,
  isDecisionEvent,
  isDocEvent,
  isFactEvent,
  isMigrationImportEvent,
  isTaskEvent,
  validateCurrentCanonicalEvent,
  validateCurrentDocEvent,
  type DocEventV1,
} from "../domain/doc-sync.contract.ts";
import { assertMigrationImportWritePlan } from "../domain/migration-import-event.ts";
import {
  assertLedgerLayoutMigrationWritePlan,
  isLedgerLayoutMigrationEvent,
} from "../domain/ledger-layout-migration-event.ts";
import { assertDecisionWritePlan } from "../domain/decision-event.ts";
import { assertFactWritePlan } from "../domain/fact-event.ts";
import { assertRelationEventWritePlan, isRelationEvent } from "../domain/relation-event.ts";
import { assertTaskLifecycleWritePlan } from "../domain/task-lifecycle-publication.ts";
import {
  assertTaskBootstrapWritePlan,
  isTaskBootstrapEvent,
  type TaskBootstrapEventV1,
} from "../domain/task-bootstrap-event.ts";
import { assertTaskProgressWritePlan, isTaskProgressEvent } from "../domain/task-progress-event.ts";
import { assertScheduleEventInputs, isScheduleEvent } from "../domain/schedule-event.ts";
import { assertSettingsEventInputs, isSettingsEvent } from "../domain/settings-event.ts";
import { assertVerticalDeclarationEventInputs, isVerticalDeclarationEvent } from "../domain/vertical-declaration.ts";
import { assertPeopleEventInputs, isPeopleEvent } from "../domain/people-event.ts";
import { assertSnapshotUpgradeInputs, isSnapshotUpgradeEvent } from "../domain/task-snapshot-upgrade-store-seam.ts";
import {
  isFrozenWritePlan,
  sameWriteTarget,
  sameWriteTargets,
  normalizeContentAddressedInputs,
  WriteChainContractError,
  type FrozenWritePlan,
  type WriteTarget,
} from "../domain/write-chain.contract.ts";
import { sha256Bytes } from "../integrity/stable-hash.ts";
import { assertPublishableOpId, eventObjectTarget } from "../layout/ledger-object-layout.ts";
import type { CanonicalContentBlob, CanonicalEventWriteBundle } from "./task-event-store-types.ts";
import { TaskEventStoreError } from "./task-event-store-types.ts";
import { canonicalDocumentClaims, contentClaims } from "./task-event-store-claims-layout.ts";

// Bundle, plan, content-input, and prepared-publication validation.
export function assertBundle(bundle: CanonicalEventWriteBundle): void {
  const { event, plan, blobs } = bundle;
  assertPublishableOpId(event.opId);
  if (!isFrozenWritePlan(plan))
    throw new TaskEventStoreError("invalid_write_plan", "canonical write bundle requires one frozen write plan");
  if (isDocEvent(event)) {
    const docErrors = validateCurrentDocEvent(event);
    if (docErrors.length)
      throw new TaskEventStoreError("invalid_write_plan", "doc event write requires the current cut identity");
    assertDocWritePlan(event, plan);
  }
  const currentErrors = validateCurrentCanonicalEvent(event);
  if (currentErrors.length)
    throw new TaskEventStoreError(
      "invalid_write_plan",
      `canonical write requires the current event shape: ${currentErrors.join("; ")}`,
    );
  if (isEntityEvent(event))
    try {
      assertEntityEventInputs(event, plan, blobs);
    } catch {
      throw new TaskEventStoreError(
        "invalid_write_plan",
        "entity event must carry schema-valid evidence and an exact write plan",
      );
    }
  if (isScheduleEvent(event))
    try {
      assertScheduleEventInputs(event, plan, requireTextBlobs(blobs));
    } catch {
      throw new TaskEventStoreError(
        "invalid_write_plan",
        "schedule event must carry an exact definition-only claim or run-only evidence plan",
      );
    }
  if (isSettingsEvent(event))
    try {
      assertSettingsEventInputs(event, plan, requireTextBlobs(blobs));
    } catch {
      throw new TaskEventStoreError(
        "invalid_write_plan",
        "settings event must carry an exact harness.yaml claim and write plan",
      );
    }
  if (isVerticalDeclarationEvent(event))
    try {
      assertVerticalDeclarationEventInputs(event, plan, requireTextBlobs(blobs));
    } catch {
      throw new TaskEventStoreError(
        "invalid_write_plan",
        "vertical declaration event must carry an exact vertical.json claim and write plan",
      );
    }
  if (isPeopleEvent(event))
    try {
      assertPeopleEventInputs(event, plan, requireTextBlobs(blobs));
    } catch {
      throw new TaskEventStoreError(
        "invalid_write_plan",
        "people event must carry an exact people.yaml claim and write plan",
      );
    }
  if (isTaskEvent(event))
    try {
      assertTaskLifecycleWritePlan(event, plan);
    } catch {
      throw new TaskEventStoreError(
        "invalid_write_plan",
        "lifecycle write plan must exactly declare event, documents, blobs, lease, and projections",
      );
    }
  if (isTaskBootstrapEvent(event)) assertBootstrapInputs(event, plan);
  if (isSnapshotUpgradeEvent(event))
    try {
      assertSnapshotUpgradeInputs(event, plan, requireTextBlobs(blobs));
    } catch {
      throw new TaskEventStoreError("invalid_write_plan", "snapshot upgrade inputs or plan are invalid");
    }
  if (isTaskProgressEvent(event))
    try {
      assertTaskProgressWritePlan(event, plan);
    } catch {
      throw new TaskEventStoreError(
        "invalid_write_plan",
        "progress write plan must exactly declare event, document, blob, and projection targets",
      );
    }
  if (isFactEvent(event))
    try {
      assertFactWritePlan(event, plan);
    } catch {
      throw new TaskEventStoreError(
        "invalid_write_plan",
        "fact write plan must exactly declare event, document, blob, and projection targets",
      );
    }
  if (isDecisionEvent(event))
    try {
      assertDecisionWritePlan(event, plan);
    } catch {
      throw new TaskEventStoreError(
        "invalid_write_plan",
        "decision write plan must exactly declare event, document, blob, and projection targets",
      );
    }
  if (isRelationEvent(event))
    try {
      assertRelationEventWritePlan(event, plan);
    } catch {
      throw new TaskEventStoreError(
        "invalid_write_plan",
        "relation event plan must exactly declare event, head, and relation projection targets",
      );
    }
  if (isMigrationImportEvent(event))
    try {
      assertMigrationImportWritePlan(event, plan);
    } catch {
      throw new TaskEventStoreError(
        "invalid_write_plan",
        "migration import plan must exactly declare event, entity, document, and blob targets",
      );
    }
  if (isLedgerLayoutMigrationEvent(event))
    try {
      assertLedgerLayoutMigrationWritePlan(event, plan);
    } catch {
      throw new TaskEventStoreError(
        "invalid_write_plan",
        "ledger layout migration plan must exactly declare event, head, and layout projection targets",
      );
    }
  const required: WriteTarget[] = [
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
    ],
    claims = contentClaims(event);
  if (required.some((target) => !plan.targets.some((candidate) => sameWriteTarget(candidate, target))))
    throw new TaskEventStoreError("invalid_write_plan", "canonical write bundle must declare its event and head");
  const normalizedClaims = assertContentInputs(claims, blobs, "canonical bundle"),
    declaredAuthored = plan.targets.filter((target) => target.kind === "authored_file"),
    expectedAuthored: WriteTarget[] = canonicalDocumentClaims(event).map((claim) => ({
      kind: "authored_file",
      path: claim.path,
      operation: "replace",
      sha256: claim.sha256,
      size: claim.size,
      mediaType: claim.mediaType,
    }));
  if (
    !sameWriteTargets(declaredAuthored, expectedAuthored) ||
    !sameWriteTargets(
      plan.targets.filter((target) => target.kind === "content_blob"),
      normalizedClaims.map((claim) => ({
        kind: "content_blob",
        sha256: claim.sha256,
        size: claim.size,
        mediaType: claim.mediaType,
      })),
    )
  )
    throw new TaskEventStoreError("invalid_write_plan", "canonical write bundle claims and plan differ");
}

function requireTextBlobs(blobs: readonly CanonicalContentBlob[]): readonly (CanonicalContentBlob & {
  readonly body: string;
})[] {
  if (blobs.some((blob) => typeof blob.body !== "string"))
    throw new TaskEventStoreError("invalid_write_plan", "this canonical event accepts text content only");
  return blobs as readonly (CanonicalContentBlob & { readonly body: string })[];
}
export function assertDocWritePlan(event: DocEventV1, plan: FrozenWritePlan): void {
  try {
    assertDocSyncWritePlan(event, plan as FrozenWritePlan<"DocSyncSubmit">);
  } catch {
    throw new TaskEventStoreError(
      "invalid_write_plan",
      "doc write plan must exactly declare event, head, projection, and content targets",
    );
  }
}
export function assertBootstrapInputs(event: TaskBootstrapEventV1, plan: FrozenWritePlan): void {
  try {
    assertTaskBootstrapWritePlan(event, plan as FrozenWritePlan<"TaskBootstrap">);
  } catch {
    throw new TaskEventStoreError(
      "invalid_write_plan",
      "task bootstrap write plan must exactly declare event, task, snapshot, documents, and blobs",
    );
  }
}
export function assertContentInputs(
  claims: readonly {
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
  }[],
  blobs: readonly {
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
    readonly body: string | Uint8Array;
  }[],
  label: string,
): typeof claims {
  let normalizedClaims: readonly (typeof claims)[number][];
  let normalizedBlobs: readonly (typeof blobs)[number][];
  try {
    normalizedClaims = normalizeContentAddressedInputs(claims);
    normalizedBlobs = normalizeContentAddressedInputs(blobs);
  } catch (error) {
    if (!(error instanceof WriteChainContractError)) throw error;
    throw new TaskEventStoreError("invalid_write_plan", `${label} content inputs conflict for one SHA`);
  }
  // Blobs may cover a subset of the claims: an object the store already holds needs no bytes resupplied, and
  // prepareContentObjects rejects a claim with neither a blob nor a stored object. Every supplied blob is
  // hashed here — the one place content bytes are verified — and must match the claim it stands for.
  const claimsBySha = new Map(normalizedClaims.map((claim) => [claim.sha256, claim]));
  if (
    normalizedBlobs.some((blob) => {
      const claim = claimsBySha.get(blob.sha256),
        bytes = typeof blob.body === "string" ? Buffer.from(blob.body) : blob.body;
      return (
        claim === undefined ||
        claim.size !== blob.size ||
        claim.mediaType !== blob.mediaType ||
        bytes.byteLength !== blob.size ||
        sha256Bytes(bytes) !== blob.sha256
      );
    })
  )
    throw new TaskEventStoreError(
      "invalid_write_plan",
      `${label} content inputs must exactly match the frozen write plan`,
    );
  return normalizedClaims;
}
