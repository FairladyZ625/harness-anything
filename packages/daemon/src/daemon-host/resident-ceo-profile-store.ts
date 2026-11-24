import type { ResidentCeoProfile } from "@harness-anything/kernel/internal/domain/resident-ceo.ts";

export interface ResidentCeoProfileStore {
  readonly read: (principalPersonId: string) => Promise<ResidentCeoProfile | null>;
  readonly write: (profile: ResidentCeoProfile, expectedUpdatedAt: string | null) => Promise<void>;
}

const profileWriteQueues = new Map<string, Promise<void>>();

export function openResidentCeoProfileStore(input: {
  readonly key: string;
  readonly readSerialized: () => Promise<string | undefined>;
  readonly writeSerialized: (value: string) => Promise<void>;
}): ResidentCeoProfileStore {
  const readProfiles = async (): Promise<Record<string, ResidentCeoProfile>> => {
    const serialized = await input.readSerialized();
    if (serialized === undefined) return {};
    const value: unknown = JSON.parse(serialized);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Resident CEO profiles are malformed.");
    const profiles = value as Record<string, ResidentCeoProfile>;
    for (const [principalPersonId, profile] of Object.entries(profiles)) {
      if (
        profile.schema !== "resident-ceo-profile/v1" ||
        profile.principalPersonId !== principalPersonId ||
        typeof profile.updatedAt !== "string"
      )
        throw new Error(`Resident CEO profile for ${principalPersonId} has an invalid identity or schema.`);
    }
    return profiles;
  };

  return {
    read: async (principalPersonId) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(principalPersonId))
        throw new Error("Resident CEO principal id is invalid.");
      const profile = (await readProfiles())[principalPersonId] ?? null;
      if (
        profile !== null &&
        (profile.schema !== "resident-ceo-profile/v1" ||
          profile.principalPersonId !== principalPersonId ||
          typeof profile.updatedAt !== "string")
      )
        throw new Error(`Resident CEO profile for ${principalPersonId} has an invalid identity or schema.`);
      return profile;
    },
    write: async (profile, expectedUpdatedAt) => {
      const previous = profileWriteQueues.get(input.key) ?? Promise.resolve();
      let release!: () => void;
      const currentWrite = new Promise<void>((resolve) => (release = resolve));
      const queuedWrite = previous.then(() => currentWrite);
      profileWriteQueues.set(input.key, queuedWrite);
      await previous;
      try {
        const profiles = await readProfiles(),
          current = profiles[profile.principalPersonId] ?? null;
        if ((current?.updatedAt ?? null) !== expectedUpdatedAt)
          throw new Error(`Resident CEO profile for ${profile.principalPersonId} changed before write.`);
        await input.writeSerialized(JSON.stringify({ ...profiles, [profile.principalPersonId]: profile }));
      } finally {
        release();
        if (profileWriteQueues.get(input.key) === queuedWrite) profileWriteQueues.delete(input.key);
      }
    },
  };
}
