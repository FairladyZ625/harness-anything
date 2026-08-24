import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import { stableStringify } from "../integrity/stable-hash.ts";
import { digest } from "./digest.ts";
import { validateTaskV1, type TaskV1 } from "./task.ts";
import { type InitialDocumentClaim, type PresetSnapshotClaim, type TaskBootstrapBlob } from "./task-bootstrap-event.ts";
import {
  freezeDeclaredWritePlan,
  hasOnlyFields,
  hasRequiredFields,
  isFrozenWritePlan,
  isNonEmptyString,
  isRecord,
  validateEventEnvelopeIdentity,
  type ActorIdentity,
  type EventEnvelope,
  type FrozenWritePlan,
  type WriteTarget,
} from "./write-chain.contract.ts";

export type PresetSnapshotUpgradeEventV1 = EventEnvelope<
  "preset-snapshot-upgrade-event/v1",
  "preset_snapshot_upgraded",
  ActorIdentity,
  {
    readonly previousDigest: `sha256:${string}`;
    readonly task: TaskV1;
    readonly presetSnapshotClaim: PresetSnapshotClaim;
    readonly taskContractClaim: InitialDocumentClaim;
  }
> & { readonly taskId: string };
export interface PresetSnapshotUpgradeBundle {
  readonly event: PresetSnapshotUpgradeEventV1;
  readonly plan: FrozenWritePlan<"PresetSnapshotUpgrade">;
  readonly blobs: readonly TaskBootstrapBlob[];
}
export function validatePresetSnapshotUpgradeEvent(value: unknown): readonly string[] {
  return validatePresetSnapshotUpgradeEventFields(value, true);
}
export function validateCurrentPresetSnapshotUpgradeEvent(value: unknown): readonly string[] {
  return validatePresetSnapshotUpgradeEventFields(value, false);
}
function validatePresetSnapshotUpgradeEventFields(value: unknown, allowUnknownFields: boolean): readonly string[] {
  const hasFields = allowUnknownFields ? hasRequiredFields : hasOnlyFields;
  if (
    !isRecord(value) ||
    !hasFields(value, [
      "schema",
      "eventId",
      "workspaceRevision",
      "opId",
      "taskId",
      "type",
      "actor",
      "source",
      "occurredAt",
      "payload",
    ]) ||
    value.schema !== "preset-snapshot-upgrade-event/v1" ||
    value.type !== "preset_snapshot_upgraded" ||
    !isNonEmptyString(value.taskId) ||
    !isRecord(value.payload) ||
    !hasFields(value.payload, ["previousDigest", "task", "presetSnapshotClaim", "taskContractClaim"])
  )
    return ["preset snapshot upgrade envelope or payload is invalid"];
  const task = value.payload.task,
    snapshot = value.payload.presetSnapshotClaim,
    contract = value.payload.taskContractClaim,
    previous = value.payload.previousDigest;
  if (
    validateTaskV1(task, allowUnknownFields).length ||
    !isRecord(task) ||
    task.taskId !== value.taskId ||
    !digest(previous) ||
    !snapshotClaim(snapshot, allowUnknownFields) ||
    task.presetSnapshotDigest !== snapshot.digest ||
    previous === snapshot.digest ||
    !contractClaim(contract, value.taskId, allowUnknownFields)
  )
    return ["preset snapshot upgrade claims are invalid"];
  return validateEventEnvelopeIdentity(value, allowUnknownFields).length
    ? ["preset snapshot upgrade identity is invalid"]
    : [];
}
export function isPresetSnapshotUpgradeEvent(event: {
  readonly schema: string;
}): event is PresetSnapshotUpgradeEventV1 {
  return event.schema === "preset-snapshot-upgrade-event/v1";
}
export function presetSnapshotUpgradeClaims(
  event: PresetSnapshotUpgradeEventV1,
): readonly (PresetSnapshotClaim | InitialDocumentClaim)[] {
  return [
    ...new Map(
      [event.payload.presetSnapshotClaim, event.payload.taskContractClaim].map((claim) => [claim.sha256, claim]),
    ).values(),
  ];
}
export function presetSnapshotUpgradeWritePlan(
  event: PresetSnapshotUpgradeEventV1,
): FrozenWritePlan<"PresetSnapshotUpgrade"> {
  const contract = event.payload.taskContractClaim,
    targets: WriteTarget[] = [
      { kind: "event_file", path: eventObjectTarget(event.opId), operation: "create" },
      { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
      { kind: "projection_invalidation", projection: "task-lifecycle/v1", key: event.taskId },
      {
        kind: "projection_invalidation",
        projection: "preset-snapshot/v1",
        key: event.payload.presetSnapshotClaim.digest,
      },
      {
        kind: "authored_file",
        path: contract.path,
        operation: "replace",
        sha256: contract.sha256,
        size: contract.size,
        mediaType: contract.mediaType,
      },
      { kind: "projection_invalidation", projection: "document/v1", key: contract.path },
    ];
  for (const claim of presetSnapshotUpgradeClaims(event))
    targets.push({ kind: "content_blob", sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType });
  return freezeDeclaredWritePlan({ commandType: "PresetSnapshotUpgrade", targets }, ["PresetSnapshotUpgrade"]);
}
export function assertPresetSnapshotUpgradeWritePlan(
  event: PresetSnapshotUpgradeEventV1,
  plan: FrozenWritePlan<"PresetSnapshotUpgrade"> | undefined,
): asserts plan is FrozenWritePlan<"PresetSnapshotUpgrade"> {
  const shape = (value: FrozenWritePlan<"PresetSnapshotUpgrade">) =>
    stableStringify({ commandType: value.commandType, targets: value.targets.map(stableStringify).sort() });
  if (plan === undefined || !isFrozenWritePlan(plan) || shape(plan) !== shape(presetSnapshotUpgradeWritePlan(event)))
    throw new Error("preset snapshot upgrade plan must exactly declare task, snapshot, contract, and blobs");
}
function storedClaim(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    isRecord(value) &&
    /^[0-9a-f]{64}$/u.test(String(value.sha256)) &&
    Number.isSafeInteger(value.size) &&
    (value.size as number) >= 0 &&
    isNonEmptyString(value.mediaType)
  );
}
function snapshotClaim(value: unknown, allowUnknownFields: boolean): value is PresetSnapshotClaim {
  return (
    storedClaim(value) &&
    (allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, ["digest", "sha256", "size", "mediaType"]) &&
    digest(value.digest) &&
    value.mediaType === "application/json"
  );
}
function contractClaim(value: unknown, taskId: string, allowUnknownFields: boolean): value is InitialDocumentClaim {
  if (
    !storedClaim(value) ||
    !(allowUnknownFields ? hasRequiredFields : hasOnlyFields)(value, [
      "path",
      "sha256",
      "size",
      "mediaType",
      "owner",
      "policyId",
    ]) ||
    value.mediaType !== "application/json" ||
    value.owner !== "machine" ||
    value.policyId !== "typed-machine-writer/v1" ||
    typeof value.path !== "string"
  )
    return false;
  try {
    return (
      normalizeRelativeDocumentPath(value.path) === value.path &&
      value.path.startsWith(`tasks/${taskId}-`) &&
      value.path.endsWith("/task-contract.json")
    );
  } catch {
    return false;
  }
}
