import { assertEntityUpsertInputs, isEntityEvent } from "../domain/entity-event.ts";
import {
  assertDocSyncWritePlan,
  isDecisionEvent,
  isDocEvent,
  isFactEvent,
  isMigrationImportEvent,
  isTaskEvent,
  parseCanonicalEvent,
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
import { assertTaskLifecycleWritePlan } from "../domain/task-lifecycle-publication.ts";
import {
  assertTaskBootstrapWritePlan,
  isTaskBootstrapEvent,
  taskBootstrapClaims,
  type TaskBootstrapEventV1,
} from "../domain/task-bootstrap-event.ts";
import { assertTaskProgressWritePlan, isTaskProgressEvent } from "../domain/task-progress-event.ts";
import { assertScheduleEventInputs, isScheduleEvent } from "../domain/schedule-event.ts";
import { assertSettingsEventInputs, isSettingsEvent } from "../domain/settings-event.ts";
import { assertSnapshotUpgradeInputs, isSnapshotUpgradeEvent } from "../domain/task-snapshot-upgrade-store-seam.ts";
import {
  isFrozenWritePlan,
  type EventHead,
  type FrozenWritePlan,
  type WriteTarget,
} from "../domain/write-chain.contract.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { assertPublishableOpId, eventObjectTarget } from "../layout/ledger-object-layout.ts";
import { type LedgerGitLayout } from "./ledger-git-layout.ts";
import type {
  CanonicalContentBlob,
  CanonicalWriteBundle,
  PublicationFile,
  PublicationWrite,
} from "./task-event-store-types.ts";
import { TaskEventStoreError } from "./task-event-store-types.ts";
import { canonicalDocumentClaims, contentClaims, targetShape } from "./task-event-store-claims-layout.ts";
import { eventObjectPaths } from "./task-event-store-layout.ts";
import { validateEventBlobs } from "./task-event-store-reads.ts";

// Bundle, plan, content-input, and prepared-publication validation.
export function assertBundle(bundle: CanonicalWriteBundle): void {
  const { event, plan, blobs } = bundle;
  assertPublishableOpId(event.opId);
  if (!isFrozenWritePlan(plan))
    throw new TaskEventStoreError("invalid_write_plan", "canonical write bundle requires one frozen write plan");
  if (isDocEvent(event)) {
    if (validateCurrentDocEvent(event).length)
      throw new TaskEventStoreError("invalid_write_plan", "doc event write requires the current cut identity");
    assertDocWritePlan(event, plan, blobs);
  }
  const currentErrors = validateCurrentCanonicalEvent(event);
  if (currentErrors.length)
    throw new TaskEventStoreError(
      "invalid_write_plan",
      `canonical write requires the current event shape: ${currentErrors.join("; ")}`,
    );
  if (isEntityEvent(event))
    try {
      assertEntityUpsertInputs(event, plan as FrozenWritePlan<"EntityUpsert">, blobs);
    } catch {
      throw new TaskEventStoreError(
        "invalid_write_plan",
        "entity upsert must carry a schema-valid declaration and exact write plan",
      );
    }
  if (isScheduleEvent(event))
    try {
      assertScheduleEventInputs(event, plan, blobs);
    } catch {
      throw new TaskEventStoreError(
        "invalid_write_plan",
        "schedule event must carry an exact definition-only claim or run-only evidence plan",
      );
    }
  if (isSettingsEvent(event))
    try {
      assertSettingsEventInputs(event, plan, blobs);
    } catch {
      throw new TaskEventStoreError(
        "invalid_write_plan",
        "settings event must carry an exact harness.yaml claim and write plan",
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
  if (isTaskBootstrapEvent(event)) assertBootstrapInputs(event, plan, blobs);
  if (isSnapshotUpgradeEvent(event))
    try {
      assertSnapshotUpgradeInputs(event, plan, blobs);
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
  if (
    required.some((target) => !plan.targets.some((candidate) => stableStringify(candidate) === stableStringify(target)))
  )
    throw new TaskEventStoreError("invalid_write_plan", "canonical write bundle must declare its event and head");
  assertContentInputs(claims, blobs, "canonical bundle");
  const declaredAuthored = plan.targets.filter((target) => target.kind === "authored_file"),
    expectedAuthored: WriteTarget[] = canonicalDocumentClaims(event).map((claim) => ({
      kind: "authored_file",
      path: claim.path,
      operation: "replace",
      sha256: claim.sha256,
      size: claim.size,
      mediaType: claim.mediaType,
    }));
  if (
    targetShape(declaredAuthored) !== targetShape(expectedAuthored) ||
    targetShape(plan.targets.filter((target) => target.kind === "content_blob")) !==
      targetShape(
        claims.map((claim) => ({
          kind: "content_blob",
          sha256: claim.sha256,
          size: claim.size,
          mediaType: claim.mediaType,
        })),
      )
  )
    throw new TaskEventStoreError("invalid_write_plan", "canonical write bundle claims and plan differ");
}
export function assertDocWritePlan(
  event: DocEventV1,
  plan: FrozenWritePlan,
  blobs: readonly CanonicalContentBlob[],
): void {
  try {
    assertDocSyncWritePlan(event, plan as FrozenWritePlan<"DocSyncSubmit">);
  } catch {
    throw new TaskEventStoreError(
      "invalid_write_plan",
      "doc write plan must exactly declare event, head, projection, and content targets",
    );
  }
  assertContentInputs(
    event.payload.changes.flatMap(({ candidate }) => (candidate === null ? [] : [candidate])),
    blobs,
    "doc",
  );
}
export function assertBootstrapInputs(
  event: TaskBootstrapEventV1,
  plan: FrozenWritePlan,
  blobs: readonly CanonicalContentBlob[],
): void {
  try {
    assertTaskBootstrapWritePlan(event, plan as FrozenWritePlan<"TaskBootstrap">);
  } catch {
    throw new TaskEventStoreError(
      "invalid_write_plan",
      "task bootstrap write plan must exactly declare event, task, snapshot, documents, and blobs",
    );
  }
  const claims = taskBootstrapClaims(event);
  assertContentInputs(claims, blobs, "task bootstrap");
  const claim = claims[0];
  if (!claim || !("digest" in claim))
    throw new TaskEventStoreError("invalid_write_plan", "task bootstrap snapshot claim is missing");
  const blob = blobs.find((candidate) => candidate.sha256 === claim.sha256);
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(blob?.body ?? "") as Record<string, unknown>;
  } catch {
    throw new TaskEventStoreError("invalid_write_plan", "task bootstrap snapshot claim must be JSON");
  }
  const { digest, ...snapshot } = value;
  if (digest !== claim.digest || claim.digest !== `sha256:${sha256Text(stableStringify(snapshot))}`)
    throw new TaskEventStoreError(
      "invalid_write_plan",
      "task bootstrap snapshot claim digest must match its canonical bytes",
    );
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
    readonly body: string;
  }[],
  label: string,
): void {
  const shape = (
    items: readonly {
      readonly sha256: string;
      readonly size: number;
      readonly mediaType: string;
    }[],
  ) =>
    stableStringify(
      items
        .map(({ sha256, size, mediaType }) => ({ sha256, size, mediaType }))
        .sort((a, b) => a.sha256.localeCompare(b.sha256)),
    );
  if (
    shape(blobs) !== shape(claims) ||
    blobs.some((blob) => Buffer.byteLength(blob.body) !== blob.size || sha256Text(blob.body) !== blob.sha256)
  )
    throw new TaskEventStoreError(
      "invalid_write_plan",
      `${label} content inputs must exactly match the frozen write plan`,
    );
}
export function validatePrepared(
  ledger: LedgerGitLayout,
  commit: string,
  files: readonly PublicationFile[],
  head: EventHead,
): void {
  const body = files.find(
    (file): file is PublicationWrite =>
      "target" in file && (eventObjectPaths(ledger, head.opId) as readonly string[]).includes(file.target),
  )?.body;
  if (!body) throw new Error("prepared commit has no changed event");
  const event = parseCanonicalEvent(body);
  validateEventBlobs(
    ledger,
    commit,
    event,
    files.filter((file): file is PublicationWrite => "target" in file),
  );
  if (event.workspaceRevision !== head.revision || head.eventDigest !== `sha256:${sha256Text(body)}`)
    throw new Error("prepared event/head mismatch");
}
