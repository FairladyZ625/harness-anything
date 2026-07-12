import type { FdeEvidence } from "./fde-detector.ts";

export type AtRestDegradation = "read-only" | "disabled";

export interface AtRestProfile {
  readonly schema: "at-rest-profile/v1";
  readonly profileId: string;
  readonly version: number;
  readonly writableRequirement: "attested-full-volume-encryption";
  readonly onNotEncrypted: AtRestDegradation;
  readonly onIndeterminate: AtRestDegradation;
}

export interface AtRestProfileEvaluation {
  readonly profileId: string;
  readonly evidence: FdeEvidence;
  readonly accessMode: "writable" | "read-only" | "disabled";
  readonly writableAllowed: boolean;
  readonly degraded: boolean;
  readonly reason: "fde_attested" | "fde_not_encrypted" | "fde_indeterminate";
}

export const strictWritableAtRestProfile: AtRestProfile = Object.freeze({
  schema: "at-rest-profile/v1",
  profileId: "writable-fde-required",
  version: 1,
  writableRequirement: "attested-full-volume-encryption",
  onNotEncrypted: "disabled",
  onIndeterminate: "disabled"
});

export function evaluateAtRestProfile(
  profile: AtRestProfile,
  evidence: FdeEvidence
): AtRestProfileEvaluation {
  validateAtRestProfile(profile);
  if (evidence.state === "encrypted") {
    return {
      profileId: profile.profileId,
      evidence,
      accessMode: "writable",
      writableAllowed: true,
      degraded: false,
      reason: "fde_attested"
    };
  }

  const reason = evidence.state === "not-encrypted" ? "fde_not_encrypted" : "fde_indeterminate";
  const policy = evidence.state === "not-encrypted" ? profile.onNotEncrypted : profile.onIndeterminate;
  return {
    profileId: profile.profileId,
    evidence,
    accessMode: policy === "read-only" ? "read-only" : "disabled",
    writableAllowed: false,
    degraded: true,
    reason
  };
}

function validateAtRestProfile(profile: AtRestProfile): void {
  if (profile.schema !== "at-rest-profile/v1"
    || !profile.profileId.trim()
    || !Number.isSafeInteger(profile.version)
    || profile.version < 1
    || profile.writableRequirement !== "attested-full-volume-encryption") {
    throw new Error("Invalid AtRestProfile declaration.");
  }
}
