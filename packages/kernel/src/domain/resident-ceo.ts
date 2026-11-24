export const RESIDENT_CEO_PROFILE_SCHEMA = "resident-ceo-profile/v1" as const;
export const RESIDENT_CEO_MIN_HEARTBEAT_INTERVAL_SEC = 30;
export const RESIDENT_CEO_MAX_HEARTBEAT_INTERVAL_SEC = 86_400;

export type ResidentCeoWakeCause = "heartbeat" | "peer-request" | "human-chat";
export type ResidentCeoWakeStatus = "running" | "succeeded" | "failed";

export interface ResidentCeoWakeReceipt {
  readonly wakeId: string;
  readonly cause: ResidentCeoWakeCause;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly status: ResidentCeoWakeStatus;
  readonly runtimeSessionId: string | null;
  readonly peerRequestId?: string;
  readonly detail: string | null;
}

export interface ResidentCeoProfile {
  readonly schema: typeof RESIDENT_CEO_PROFILE_SCHEMA;
  readonly principalPersonId: string;
  readonly repoId?: string;
  readonly runtimeInstanceId: string;
  readonly model: string;
  readonly heartbeatIntervalSec: number;
  readonly persistentSessionId: string | null;
  readonly status: "stopped" | "running";
  readonly lastWake: ResidentCeoWakeReceipt | null;
  readonly updatedAt: string;
}

export type ResidentCeoProfileInput = Pick<
  ResidentCeoProfile,
  "principalPersonId" | "repoId" | "runtimeInstanceId" | "model" | "heartbeatIntervalSec"
>;

export class ResidentCeoProfileError extends Error {
  readonly code: "resident_ceo_invalid_profile" | "resident_ceo_principal_mismatch";

  constructor(code: ResidentCeoProfileError["code"], message: string) {
    super(message);
    this.name = "ResidentCeoProfileError";
    this.code = code;
  }
}

export function createResidentCeoProfile(input: ResidentCeoProfileInput, updatedAt: string): ResidentCeoProfile {
  const fields = [input.principalPersonId, input.runtimeInstanceId, input.model, updatedAt];
  if (
    fields.some((field) => field.trim().length === 0) ||
    !Number.isSafeInteger(input.heartbeatIntervalSec) ||
    input.heartbeatIntervalSec < RESIDENT_CEO_MIN_HEARTBEAT_INTERVAL_SEC ||
    input.heartbeatIntervalSec > RESIDENT_CEO_MAX_HEARTBEAT_INTERVAL_SEC
  ) {
    throw new ResidentCeoProfileError(
      "resident_ceo_invalid_profile",
      `Resident CEO requires a principal, runtime instance, model, timestamp, and heartbeat interval from ${RESIDENT_CEO_MIN_HEARTBEAT_INTERVAL_SEC} to ${RESIDENT_CEO_MAX_HEARTBEAT_INTERVAL_SEC} seconds.`,
    );
  }
  return {
    schema: RESIDENT_CEO_PROFILE_SCHEMA,
    principalPersonId: input.principalPersonId,
    ...(input.repoId === undefined ? {} : { repoId: input.repoId }),
    runtimeInstanceId: input.runtimeInstanceId,
    model: input.model,
    heartbeatIntervalSec: input.heartbeatIntervalSec,
    persistentSessionId: null,
    status: "stopped",
    lastWake: null,
    updatedAt,
  };
}

export function assertResidentCeoPrincipal(profile: ResidentCeoProfile, principalPersonId: string): void {
  if (profile.principalPersonId !== principalPersonId) {
    throw new ResidentCeoProfileError(
      "resident_ceo_principal_mismatch",
      `Resident CEO profile belongs to ${profile.principalPersonId}, not ${principalPersonId}.`,
    );
  }
}

export function residentCeoWakeDue(profile: ResidentCeoProfile, now: number): boolean {
  if (profile.status !== "running" || profile.lastWake?.status === "running") return false;
  if (profile.lastWake === null) return true;
  const lastWakeAt = Date.parse(profile.lastWake.completedAt ?? profile.lastWake.requestedAt);
  return Number.isFinite(lastWakeAt) && now >= lastWakeAt + profile.heartbeatIntervalSec * 1_000;
}

export function residentCeoWakeReceipt(input: {
  readonly profile: ResidentCeoProfile;
  readonly wakeId: string;
  readonly cause: ResidentCeoWakeCause;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly status: ResidentCeoWakeStatus;
  readonly runtimeSessionId: string | null;
  readonly peerRequestId?: string;
  readonly persistentSessionId?: string | null;
  readonly detail?: string | null;
}): ResidentCeoProfile {
  const receipt: ResidentCeoWakeReceipt = {
    wakeId: input.wakeId,
    cause: input.cause,
    requestedAt: input.requestedAt,
    completedAt: input.completedAt,
    status: input.status,
    runtimeSessionId: input.runtimeSessionId,
    ...(input.peerRequestId === undefined ? {} : { peerRequestId: input.peerRequestId }),
    detail: input.detail ?? null,
  };
  return {
    ...input.profile,
    persistentSessionId: input.persistentSessionId ?? input.profile.persistentSessionId,
    lastWake: receipt,
    updatedAt: input.completedAt ?? input.requestedAt,
  };
}
