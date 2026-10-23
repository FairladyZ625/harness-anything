import { consumeKnownError } from "../api/error-consumption.ts";
import { isRendererRecord } from "./result-validation.ts";

const schema = "live-floor-preferences/v1",
  storageKey = "harness:gui:live-floor-preferences";

/** 「现场」页顶部范围开关的本机便利项(业主 2026-10-21 14:20:记住上次选择)。 */
export interface LiveFloorPreferences {
  readonly scope: "project" | "all";
}

export const defaultLiveFloorPreferences: LiveFloorPreferences = { scope: "project" };

export interface LiveFloorPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readLiveFloorPreferences(storage: Pick<LiveFloorPreferenceStorage, "getItem">): LiveFloorPreferences {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(storageKey) ?? "null");
    if (!isRendererRecord(parsed) || parsed.schema !== schema) return { ...defaultLiveFloorPreferences };
    if (parsed.scope !== "project" && parsed.scope !== "all") return { ...defaultLiveFloorPreferences };
    return { scope: parsed.scope };
  } catch (cause) {
    consumeKnownError(cause);
    return { ...defaultLiveFloorPreferences };
  }
}

export function writeLiveFloorPreferences(
  storage: Pick<LiveFloorPreferenceStorage, "setItem">,
  preferences: LiveFloorPreferences,
): void {
  try {
    storage.setItem(storageKey, JSON.stringify({ schema, ...preferences }));
  } catch (cause) {
    consumeKnownError(cause);
  }
}
