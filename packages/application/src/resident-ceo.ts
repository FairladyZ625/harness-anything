import {
  assertResidentCeoPrincipal,
  createResidentCeoProfile,
  residentCeoWakeDue,
  residentCeoWakeReceipt,
  type ResidentCeoProfile,
  type ResidentCeoProfileInput,
  type ResidentCeoWakeCause,
} from "@harness-anything/kernel/internal/domain/resident-ceo.ts";

export interface ResidentCeoProfileStore {
  readonly read: (principalPersonId: string) => Promise<ResidentCeoProfile | null>;
  /** Writes are serialized by the owning daemon writer. */
  readonly write: (profile: ResidentCeoProfile, expectedUpdatedAt: string | null) => Promise<void>;
}

export interface ResidentCeoRuntime {
  readonly run: (input: {
    readonly principalPersonId: string;
    readonly runtimeInstanceId: string;
    readonly model: string;
    readonly persistentSessionId: string | null;
    readonly cause: ResidentCeoWakeCause;
    readonly message: string;
    readonly wakeId: string;
    readonly peerRequestId?: string;
  }) => Promise<{
    readonly runtimeSessionId: string;
    readonly response: Promise<{ readonly response: string; readonly persistentSessionId: string | null }>;
  }>;
}

export interface ResidentCeoServiceInput {
  readonly profiles: ResidentCeoProfileStore;
  readonly runtime: ResidentCeoRuntime;
  readonly now: () => string;
  readonly createId: () => string;
}

export function makeResidentCeoService(input: ResidentCeoServiceInput) {
  const requiredProfile = async (principalPersonId: string): Promise<ResidentCeoProfile> => {
    const profile = await input.profiles.read(principalPersonId);
    if (profile === null) throw new Error(`Resident CEO is not configured for ${principalPersonId}.`);
    assertResidentCeoPrincipal(profile, principalPersonId);
    return profile;
  };

  const update = async (profile: ResidentCeoProfile, next: ResidentCeoProfile): Promise<ResidentCeoProfile> => {
    const updated = {
      ...next,
      updatedAt: new Date(Math.max(Date.parse(next.updatedAt), Date.parse(profile.updatedAt) + 1)).toISOString(),
    };
    await input.profiles.write(updated, profile.updatedAt);
    return updated;
  };

  return {
    configure: async (principalPersonId: string, configuration: Omit<ResidentCeoProfileInput, "principalPersonId">) => {
      const previous = await input.profiles.read(principalPersonId);
      if (previous !== null) assertResidentCeoPrincipal(previous, principalPersonId);
      if (previous?.lastWake?.status === "running")
        throw Object.assign(new Error("Resident CEO has a turn in progress."), { code: "resident_ceo_busy" });
      const created = createResidentCeoProfile({ ...configuration, principalPersonId }, input.now());
      const next = previous
        ? {
            ...created,
            persistentSessionId:
              previous.repoId === created.repoId &&
              previous.runtimeInstanceId === created.runtimeInstanceId &&
              previous.model === created.model
                ? previous.persistentSessionId
                : null,
            status: previous.status,
            lastWake: previous.lastWake,
          }
        : created;
      if (previous) return update(previous, next);
      await input.profiles.write(next, null);
      return next;
    },
    start: async (principalPersonId: string) => {
      const profile = await requiredProfile(principalPersonId);
      return update(profile, { ...profile, status: "running", updatedAt: input.now() });
    },
    stop: async (principalPersonId: string) => {
      const profile = await requiredProfile(principalPersonId);
      return update(profile, { ...profile, status: "stopped", updatedAt: input.now() });
    },
    status: requiredProfile,
    wake: async (principalPersonId: string, cause: ResidentCeoWakeCause, message: string, peerRequestId?: string) => {
      let profile = await requiredProfile(principalPersonId);
      if (profile.status !== "running") throw new Error("Resident CEO is stopped.");
      if (cause === "heartbeat" && !residentCeoWakeDue(profile, Date.parse(input.now())))
        return { profile, response: null } as const;
      if (profile.lastWake?.status === "running")
        throw Object.assign(new Error("Resident CEO has a turn in progress."), { code: "resident_ceo_busy" });

      const wakeId = input.createId();
      const requestedAt = input.now();
      profile = await update(
        profile,
        residentCeoWakeReceipt({
          profile,
          wakeId,
          cause,
          requestedAt,
          completedAt: null,
          status: "running",
          runtimeSessionId: null,
        }),
      );
      let run: Awaited<ReturnType<ResidentCeoRuntime["run"]>>;
      try {
        run = await input.runtime.run({
          principalPersonId,
          runtimeInstanceId: profile.runtimeInstanceId,
          model: profile.model,
          persistentSessionId: profile.persistentSessionId,
          cause,
          message,
          wakeId,
          ...(peerRequestId === undefined ? {} : { peerRequestId }),
        });
      } catch (error) {
        const completedAt = input.now();
        profile = await requiredProfile(principalPersonId);
        const failed = residentCeoWakeReceipt({
          profile,
          wakeId,
          cause,
          requestedAt,
          completedAt,
          status: "failed",
          runtimeSessionId: null,
          detail: error instanceof Error ? error.message : String(error),
        });
        const saved = await update(profile, failed);
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          residentCeoProfile: saved,
        });
      }
      profile = await requiredProfile(principalPersonId);
      profile = await update(
        profile,
        residentCeoWakeReceipt({
          profile,
          wakeId,
          cause,
          requestedAt,
          completedAt: null,
          status: "running",
          runtimeSessionId: run.runtimeSessionId,
        }),
      );
      let completedResponse: Awaited<Awaited<ReturnType<ResidentCeoRuntime["run"]>>["response"]>;
      try {
        completedResponse = await run.response;
      } catch (error) {
        const completedAt = input.now();
        profile = await requiredProfile(principalPersonId);
        const failed = residentCeoWakeReceipt({
          profile,
          wakeId,
          cause,
          requestedAt,
          completedAt,
          status: "failed",
          runtimeSessionId: run.runtimeSessionId,
          detail: error instanceof Error ? error.message : String(error),
        });
        const saved = await update(profile, failed);
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          residentCeoProfile: saved,
        });
      }
      const completedAt = input.now();
      const current = await requiredProfile(principalPersonId);
      const completed = residentCeoWakeReceipt({
        profile: current,
        wakeId,
        cause,
        requestedAt,
        completedAt,
        status: "succeeded",
        runtimeSessionId: run.runtimeSessionId,
        ...(current.repoId === profile.repoId &&
        current.runtimeInstanceId === profile.runtimeInstanceId &&
        current.model === profile.model
          ? { persistentSessionId: completedResponse.persistentSessionId }
          : {}),
      });
      const saved = await update(current, completed);
      return { profile: saved, response: completedResponse.response } as const;
    },
  };
}
