import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ResidentCeoProfile, ResidentCeoProfileStore } from "@harness-anything/application/commands";

function profilePath(userRoot: string, principalPersonId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(principalPersonId))
    throw new Error("Resident CEO principal id is invalid.");
  return path.join(userRoot, "resident-ceo", `${principalPersonId}.json`);
}

export function openResidentCeoProfileStore(userRoot: string): ResidentCeoProfileStore {
  const pendingWrites = new Map<string, Promise<void>>();
  return {
    list: async () => {
      const directory = path.join(userRoot, "resident-ceo");
      let entries: string[];
      try {
        entries = readdirSync(directory).filter((entry) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/u.test(entry));
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
        throw error;
      }
      return entries.map((entry) => {
        const principalPersonId = entry.slice(0, -5),
          value: unknown = JSON.parse(readFileSync(path.join(directory, entry), "utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error(`Resident CEO profile for ${principalPersonId} is malformed.`);
        const profile = value as ResidentCeoProfile;
        if (profile.principalPersonId !== principalPersonId || profile.schema !== "resident-ceo-profile/v1")
          throw new Error(`Resident CEO profile for ${principalPersonId} has an invalid identity or schema.`);
        return profile;
      });
    },
    read: async (principalPersonId) => {
      const filePath = profilePath(userRoot, principalPersonId);
      let contents: string;
      try {
        contents = readFileSync(filePath, "utf8");
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
      const value: unknown = JSON.parse(contents);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`Resident CEO profile for ${principalPersonId} is malformed.`);
      const profile = value as ResidentCeoProfile;
      if (
        profile.schema !== "resident-ceo-profile/v1" ||
        profile.principalPersonId !== principalPersonId ||
        typeof profile.updatedAt !== "string"
      )
        throw new Error(`Resident CEO profile for ${principalPersonId} has an invalid identity or schema.`);
      return profile;
    },
    write: async (profile, expectedUpdatedAt) => {
      const filePath = profilePath(userRoot, profile.principalPersonId),
        previous = pendingWrites.get(profile.principalPersonId) ?? Promise.resolve();
      let release!: () => void;
      const currentWrite = new Promise<void>((resolve) => (release = resolve));
      const queuedWrite = previous.then(() => currentWrite);
      pendingWrites.set(profile.principalPersonId, queuedWrite);
      await previous;
      try {
        const current = await thisRead(filePath);
        if ((current?.updatedAt ?? null) !== expectedUpdatedAt)
          throw new Error(`Resident CEO profile for ${profile.principalPersonId} changed before write.`);
        mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
        const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
        try {
          renameSync(temporary, filePath);
        } catch (error) {
          rmSync(temporary, { force: true });
          throw error;
        }
      } finally {
        release();
        if (pendingWrites.get(profile.principalPersonId) === queuedWrite) pendingWrites.delete(profile.principalPersonId);
      }
    },
  };
}

async function thisRead(filePath: string): Promise<ResidentCeoProfile | null> {
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  return JSON.parse(contents) as ResidentCeoProfile;
}
