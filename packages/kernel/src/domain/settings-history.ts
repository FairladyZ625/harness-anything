import { isRecord } from "./write-chain.contract.ts";

/** Historical event data only; current Settings input remains strict. */
export function normalizeHistoricalSettingsRoles(value: unknown): unknown {
  if (!isRecord(value) || !Object.hasOwn(value, "defaultReviewer")) return value;
  const { defaultReviewer, ...settings } = value;
  if (settings.roles !== undefined && !isRecord(settings.roles))
    throw new Error("historical settings roles must be an object");
  return {
    ...settings,
    roles: { defaultReviewer, ...(settings.roles ?? {}) },
  };
}
