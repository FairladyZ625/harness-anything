const SETTINGS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_@.-]*$/u;

export interface ProjectHarnessIdentity {
  readonly mode: "local" | "remote";
  readonly personId?: string;
  readonly displayName?: string;
}

export interface ProjectHarnessDaemonSettings {
  readonly userRoot: string;
}

type Validation<Value> = { readonly ok: true; readonly value?: Value } | { readonly ok: false; readonly message: string };

export function validateDaemonSettings(value: unknown): Validation<ProjectHarnessDaemonSettings> {
  if (value === undefined) return { ok: true };
  if (!isIdentitySettingsRecord(value)) return { ok: false, message: "settings.daemon must be a mapping." };
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "userRoot") return { ok: false, message: "settings.daemon supports only userRoot." };
  if (typeof value.userRoot !== "string" || !value.userRoot.trim() || value.userRoot.includes("\0")) {
    return { ok: false, message: "settings.daemon.userRoot must be a non-empty path scalar." };
  }
  if (value.userRoot.startsWith("~") && value.userRoot !== "~" && !/^~[\\/]/u.test(value.userRoot)) {
    return { ok: false, message: "settings.daemon.userRoot supports only ~ or ~/... home-relative paths." };
  }
  return { ok: true, value: { userRoot: value.userRoot.trim() } };
}

export function validateIdentitySettings(value: unknown): Validation<ProjectHarnessIdentity> {
  if (value === undefined) return { ok: true };
  if (!isIdentitySettingsRecord(value)) return { ok: false, message: "settings.identity must be a mapping." };
  const keys = Object.keys(value).sort();
  if (keys.some((key) => key !== "displayName" && key !== "mode" && key !== "personId")) return { ok: false, message: "settings.identity supports only mode, personId, and displayName." };
  if (value.mode !== undefined && value.mode !== "local" && value.mode !== "remote") return { ok: false, message: "settings.identity.mode must be local or remote." };
  if (value.personId !== undefined && (typeof value.personId !== "string" || !SETTINGS_ID_PATTERN.test(value.personId))) return { ok: false, message: "settings.identity.personId must be a non-empty identifier when provided." };
  if (value.personId === undefined && value.displayName !== undefined) return { ok: false, message: "settings.identity.displayName requires settings.identity.personId." };
  if (value.displayName !== undefined && (typeof value.displayName !== "string" || !value.displayName.trim())) return { ok: false, message: "settings.identity.displayName must be a non-empty string when provided." };
  return { ok: true, value: {
    mode: value.mode === "remote" ? "remote" : "local",
    ...(typeof value.personId === "string" ? { personId: value.personId } : {}),
    ...(typeof value.displayName === "string" ? { displayName: value.displayName.trim() } : {})
  } };
}

function isIdentitySettingsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
