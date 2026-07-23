const SETTINGS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_@.-]*$/u;

export interface ProjectHarnessIdentity {
  readonly mode: "local" | "remote";
  readonly personId?: string;
  readonly displayName?: string;
}

/**
 * Shared connection coordinates for the remote daemon. These describe the
 * ledger repository, not the operator: every member of one project points at
 * the same remote root and repo id, so the project file owns them. The host
 * entry is the default `~/.ssh/config` alias the project publishes; an
 * operator whose alias differs overrides it from personal settings instead of
 * editing the shared file.
 */
export interface ProjectHarnessDaemonRemoteSettings {
  readonly host?: string;
  readonly root?: string;
  readonly repoId?: string;
  readonly haPath?: string;
}

export interface ProjectHarnessDaemonAdmissionSettings {
  readonly maxBytes: number;
}

export interface ProjectHarnessDaemonSettings {
  readonly userRoot?: string;
  readonly remote?: ProjectHarnessDaemonRemoteSettings;
  readonly admission?: ProjectHarnessDaemonAdmissionSettings;
}

const DAEMON_REMOTE_HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/u;
const DAEMON_REMOTE_REPO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_@.-]*$/u;

type Validation<Value> = { readonly ok: true; readonly value?: Value } | { readonly ok: false; readonly message: string };

export function validateDaemonSettings(value: unknown): Validation<ProjectHarnessDaemonSettings> {
  if (value === undefined) return { ok: true };
  if (!isIdentitySettingsRecord(value)) return { ok: false, message: "settings.daemon must be a mapping." };
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => key !== "userRoot" && key !== "remote" && key !== "admission")) {
    return { ok: false, message: "settings.daemon supports only userRoot, remote, and admission." };
  }
  let userRoot: string | undefined;
  if (value.userRoot !== undefined) {
    if (typeof value.userRoot !== "string" || !value.userRoot.trim() || value.userRoot.includes("\0")) {
      return { ok: false, message: "settings.daemon.userRoot must be a non-empty path scalar." };
    }
    if (value.userRoot.startsWith("~") && value.userRoot !== "~" && !/^~[\\/]/u.test(value.userRoot)) {
      return { ok: false, message: "settings.daemon.userRoot supports only ~ or ~/... home-relative paths." };
    }
    userRoot = value.userRoot.trim();
  }
  const remote = validateDaemonRemoteSettings(value.remote, "settings.daemon.remote");
  if (!remote.ok) return remote;
  const admission = validateDaemonAdmissionSettings(value.admission);
  if (!admission.ok) return admission;
  return {
    ok: true,
    value: {
      ...(userRoot === undefined ? {} : { userRoot }),
      ...(remote.value === undefined ? {} : { remote: remote.value }),
      ...(admission.value === undefined ? {} : { admission: admission.value })
    }
  };
}

function validateDaemonAdmissionSettings(value: unknown): Validation<ProjectHarnessDaemonAdmissionSettings> {
  if (value === undefined) return { ok: true };
  if (!isIdentitySettingsRecord(value)) return { ok: false, message: "settings.daemon.admission must be a mapping." };
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "maxBytes") {
    return { ok: false, message: "settings.daemon.admission supports only maxBytes." };
  }
  const maxBytes = positiveAdmissionByteLimit(value.maxBytes);
  if (maxBytes === undefined) {
    return { ok: false, message: "settings.daemon.admission.maxBytes must be a positive safe integer." };
  }
  return { ok: true, value: { maxBytes } };
}

/**
 * Validates one remote connection mapping. The same shape is accepted from the
 * shared project file and from personal settings, so both layers reject the
 * same malformed input with the same wording; the caller supplies the label so
 * the message names the file the operator has to fix.
 */
export function validateDaemonRemoteSettings(value: unknown, label: string): Validation<ProjectHarnessDaemonRemoteSettings> {
  if (value === undefined) return { ok: true };
  if (!isIdentitySettingsRecord(value)) return { ok: false, message: `${label} must be a mapping.` };
  const keys = Object.keys(value);
  if (keys.length === 0) return { ok: false, message: `${label} must declare at least one of host, root, repoId, or haPath.` };
  const unknown = keys.find((key) => key !== "host" && key !== "root" && key !== "repoId" && key !== "haPath");
  if (unknown !== undefined) return { ok: false, message: `${label} supports only host, root, repoId, and haPath.` };

  if (value.host !== undefined && (typeof value.host !== "string" || !DAEMON_REMOTE_HOST_PATTERN.test(value.host.trim()))) {
    return { ok: false, message: `${label}.host must be an ssh destination or ~/.ssh/config alias.` };
  }
  if (value.root !== undefined) {
    if (typeof value.root !== "string" || !value.root.trim() || value.root.includes("\0")) {
      return { ok: false, message: `${label}.root must be a non-empty path scalar.` };
    }
    if (!value.root.trim().startsWith("/")) {
      return { ok: false, message: `${label}.root must be an absolute path on the remote host.` };
    }
  }
  if (value.repoId !== undefined && (typeof value.repoId !== "string" || !DAEMON_REMOTE_REPO_ID_PATTERN.test(value.repoId.trim()))) {
    return { ok: false, message: `${label}.repoId must be a non-empty identifier.` };
  }
  if (value.haPath !== undefined && (typeof value.haPath !== "string" || !value.haPath.trim() || value.haPath.includes("\0"))) {
    return { ok: false, message: `${label}.haPath must be a non-empty path scalar.` };
  }

  return {
    ok: true,
    value: {
      ...(typeof value.host === "string" ? { host: value.host.trim() } : {}),
      ...(typeof value.root === "string" ? { root: value.root.trim() } : {}),
      ...(typeof value.repoId === "string" ? { repoId: value.repoId.trim() } : {}),
      ...(typeof value.haPath === "string" ? { haPath: value.haPath.trim() } : {})
    }
  };
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

function positiveAdmissionByteLimit(value: unknown): number | undefined {
  if (typeof value === "string" && !/^[0-9]+$/u.test(value)) return undefined;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
