import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import {
  assertPresetSnapshotUpgradeWritePlan,
  isPresetSnapshotUpgradeEvent,
  presetSnapshotUpgradeClaims,
  type PresetSnapshotUpgradeEventV1,
} from "./preset-snapshot-upgrade-event.ts";
import type { FrozenWritePlan } from "./write-chain.contract.ts";
interface SnapshotUpgradeBlob {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly body: string;
}
export function isSnapshotUpgradeEvent(event: { readonly schema: string }): event is PresetSnapshotUpgradeEventV1 {
  return isPresetSnapshotUpgradeEvent(event);
}
export function snapshotUpgradeClaims(event: PresetSnapshotUpgradeEventV1) {
  return presetSnapshotUpgradeClaims(event);
}
export function assertSnapshotUpgradeInputs(
  event: PresetSnapshotUpgradeEventV1,
  plan: FrozenWritePlan,
  blobs: readonly SnapshotUpgradeBlob[],
): void {
  assertPresetSnapshotUpgradeWritePlan(event, plan as FrozenWritePlan<"PresetSnapshotUpgrade">);
  const snapshot = blobs.find((blob) => blob.sha256 === event.payload.presetSnapshotClaim.sha256),
    contract = blobs.find((blob) => blob.sha256 === event.payload.taskContractClaim.sha256);
  let value: Record<string, unknown>, contractValue: Record<string, unknown>;
  try {
    value = JSON.parse(snapshot?.body ?? "") as Record<string, unknown>;
    contractValue = JSON.parse(contract?.body ?? "") as Record<string, unknown>;
  } catch {
    throw new Error("snapshot upgrade claims must be JSON");
  }
  const { digest, ...withoutDigest } = value;
  if (
    digest !== event.payload.presetSnapshotClaim.digest ||
    digest !== `sha256:${sha256Text(stableStringify(withoutDigest))}` ||
    contractValue.presetSnapshotDigest !== digest ||
    contractValue.taskId !== event.taskId
  )
    throw new Error("snapshot upgrade bytes do not match their claims");
}
