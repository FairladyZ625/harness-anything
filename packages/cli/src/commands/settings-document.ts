/**
 * Reads one harness settings document into a raw mapping. Parsing is
 * deliberately separate from validation: this layer only decides what the file
 * says, and every semantic rule about those values lives in the settings
 * module that consumes it.
 */
import type { DaemonRuntimePolicyValues } from "@harness-anything/daemon";

export type RawSettings = Record<string, unknown>;

const SETTINGS_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/u;

export function parseSettingsDocument(body: string): { readonly present: boolean; readonly settings: RawSettings } {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) {
    const decoded = JSON.parse(body) as { readonly settings?: RawSettings; readonly project?: { readonly locale?: unknown }; readonly vertical?: { readonly default?: unknown }; readonly presets?: { readonly default?: unknown } };
    const fromSettings = decoded.settings ?? {};
    const merged = {
      locale: fromSettings.locale ?? decoded.project?.locale,
      defaultVertical: fromSettings.defaultVertical ?? decoded.vertical?.default,
      defaultPreset: fromSettings.defaultPreset ?? decoded.presets?.default,
      defaultProfile: fromSettings.defaultProfile,
      identity: fromSettings.identity,
      daemon: fromSettings.daemon,
      daemonRuntime: fromSettings.daemonRuntime,
      tasks: fromSettings.tasks,
      execution: fromSettings.execution,
      adapters: fromSettings.adapters,
      customVerticals: fromSettings.customVerticals
    };
    return {
      present: Boolean(decoded.settings || decoded.project?.locale || decoded.vertical?.default || decoded.presets?.default),
      settings: merged
    };
  }

  return parseYamlSettings(body);
}

function parseYamlSettings(body: string): { readonly present: boolean; readonly settings: RawSettings } {
  const lines = body.split(/\r?\n/u);
  const settings: Record<string, unknown> = {};
  let inSettings = false;
  let inCustomVerticals = false;
  let inIdentity = false;
  let inDaemon = false;
  let inDaemonRemote = false;
  let inTasks = false;
  let inDaemonRuntime = false;
  let inExecution = false;
  let inAdapters = false;
  let inMultica = false;
  let foundSettings = false;

  for (const rawLine of lines) {
    const withoutComment = rawLine.replace(/\s+#.*$/u, "");
    if (!withoutComment.trim()) continue;

    const topLevel = /^([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/u.exec(withoutComment);
    if (topLevel) {
      inSettings = topLevel[1] === "settings";
      inCustomVerticals = false;
      inIdentity = false;
      inDaemon = false;
      inDaemonRemote = false;
      inTasks = false;
      inDaemonRuntime = false;
      inExecution = false;
      inAdapters = false;
      inMultica = false;
      foundSettings ||= inSettings;
      if (inSettings && topLevel[2]?.trim()) {
        throw new Error("settings must be a mapping.");
      }
      continue;
    }

    if (!inSettings) continue;

    const nested = /^  ([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/u.exec(withoutComment);
    if (nested) {
      const [, key, rawValue = ""] = nested;
      if (!SETTINGS_KEY_PATTERN.test(key)) throw new Error(`Invalid settings key: ${key}`);
      const value = rawValue.trim();
      inCustomVerticals = key === "customVerticals";
      inIdentity = key === "identity";
      inDaemon = key === "daemon";
      inDaemonRemote = false;
      inTasks = key === "tasks";
      inDaemonRuntime = key === "daemonRuntime";
      inExecution = key === "execution";
      inAdapters = key === "adapters";
      inMultica = false;
      if (inCustomVerticals) {
        if (value) throw new Error("settings.customVerticals must be a mapping.");
        settings.customVerticals = {};
        continue;
      }
      if (inIdentity) {
        if (value) throw new Error("settings.identity must be a mapping.");
        settings.identity = {};
        continue;
      }
      if (inDaemon) {
        if (value) throw new Error("settings.daemon must be a mapping.");
        settings.daemon = {};
        continue;
      }
      if (inTasks) {
        if (value) throw new Error("settings.tasks must be a mapping.");
        settings.tasks = {};
        continue;
      }
      if (inDaemonRuntime) {
        if (value) throw new Error("settings.daemonRuntime must be a mapping.");
        settings.daemonRuntime = {};
        continue;
      }
      if (inExecution) {
        if (value) throw new Error("settings.execution must be a mapping.");
        settings.execution = {};
        continue;
      }
      if (inAdapters) {
        if (value) throw new Error("settings.adapters must be a mapping.");
        settings.adapters = {};
        continue;
      }
      if (!isKnownSettingsScalar(key)) throw new Error(`Unknown settings key: ${key}`);
      if (!value) throw new Error(`settings.${key} must be a scalar value.`);
      settings[key] = unquoteScalar(value);
      continue;
    }

    const customNested = /^    ([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/u.exec(withoutComment);
    if (inCustomVerticals && customNested) {
      const [, key, rawValue = ""] = customNested;
      if (key !== "enabled") throw new Error(`Unknown settings.customVerticals key: ${key}`);
      const value = rawValue.trim();
      if (value !== "true" && value !== "false") throw new Error("settings.customVerticals.enabled must be true or false.");
      settings.customVerticals = { enabled: value === "true" };
      continue;
    }
    if (inIdentity && customNested) {
      const [, key, rawValue = ""] = customNested;
      if (key !== "mode" && key !== "personId" && key !== "displayName") throw new Error(`Unknown settings.identity key: ${key}`);
      const value = rawValue.trim();
      if (!value) throw new Error(`settings.identity.${key} must be a scalar value.`);
      settings.identity = { ...(isRecord(settings.identity) ? settings.identity : {}), [key]: unquoteScalar(value) };
      continue;
    }
    if (inDaemon && customNested) {
      const [, key, rawValue = ""] = customNested;
      if (key !== "userRoot" && key !== "remote") throw new Error(`Unknown settings.daemon key: ${key}`);
      const value = rawValue.trim();
      inDaemonRemote = key === "remote";
      const priorDaemon = isRecord(settings.daemon) ? settings.daemon : {};
      if (inDaemonRemote) {
        if (value) throw new Error("settings.daemon.remote must be a mapping.");
        settings.daemon = { ...priorDaemon, remote: {} };
        continue;
      }
      if (!value) throw new Error("settings.daemon.userRoot must be a scalar value.");
      settings.daemon = { ...priorDaemon, userRoot: unquoteScalar(value) };
      continue;
    }
    if (inTasks && customNested) {
      const [, key, rawValue = ""] = customNested;
      if (key !== "leaseEnforcement" && key !== "leaseTtlMs") throw new Error(`Unknown settings.tasks key: ${key}`);
      const value = rawValue.trim();
      if (!value) throw new Error(`settings.tasks.${key} must be a scalar value.`);
      if (key === "leaseEnforcement") {
        if (value !== "true" && value !== "false") throw new Error("settings.tasks.leaseEnforcement must be true or false.");
        settings.tasks = { ...(isRecord(settings.tasks) ? settings.tasks : {}), leaseEnforcement: value === "true" };
      } else {
        settings.tasks = { ...(isRecord(settings.tasks) ? settings.tasks : {}), leaseTtlMs: unquoteScalar(value) };
      }
      continue;
    }
    if (inExecution && customNested) {
      const [, key, rawValue = ""] = customNested;
      if (key !== "consentTtlMs") throw new Error(`Unknown settings.execution key: ${key}`);
      const value = rawValue.trim();
      if (!value) throw new Error("settings.execution.consentTtlMs must be a scalar value.");
      settings.execution = { consentTtlMs: unquoteScalar(value) };
      continue;
    }
    if (inDaemonRuntime && customNested) {
      const [, key, rawValue = ""] = customNested;
      if (!daemonRuntimeKeys.includes(key as keyof DaemonRuntimePolicyValues)) throw new Error(`Unknown settings.daemonRuntime key: ${key}`);
      const value = rawValue.trim();
      if (!value) throw new Error(`settings.daemonRuntime.${key} must be a scalar value.`);
      settings.daemonRuntime = { ...(isRecord(settings.daemonRuntime) ? settings.daemonRuntime : {}), [key]: unquoteScalar(value) };
      continue;
    }
    if (inAdapters && customNested) {
      const [, key, rawValue = ""] = customNested;
      if (key !== "multica") throw new Error(`Unknown settings.adapters key: ${key}`);
      if (rawValue.trim()) throw new Error("settings.adapters.multica must be a mapping.");
      settings.adapters = { multica: {} };
      inMultica = true;
      continue;
    }

    const deepNested = /^      ([A-Za-z][A-Za-z0-9]*):(?:\s*(.*))?$/u.exec(withoutComment);
    if (inDaemon && inDaemonRemote && deepNested) {
      const [, key, rawValue = ""] = deepNested;
      if (key !== "host" && key !== "root" && key !== "repoId" && key !== "haPath") {
        throw new Error(`Unknown settings.daemon.remote key: ${key}`);
      }
      const value = rawValue.trim();
      if (!value) throw new Error(`settings.daemon.remote.${key} must be a scalar value.`);
      const priorDaemon = isRecord(settings.daemon) ? settings.daemon : {};
      const priorRemote = isRecord(priorDaemon.remote) ? priorDaemon.remote : {};
      settings.daemon = { ...priorDaemon, remote: { ...priorRemote, [key]: unquoteScalar(value) } };
      continue;
    }
    if (inAdapters && inMultica && deepNested) {
      const [, key, rawValue = ""] = deepNested;
      if (key !== "staleTtlMs") throw new Error(`Unknown settings.adapters.multica key: ${key}`);
      const value = rawValue.trim();
      if (!value) throw new Error("settings.adapters.multica.staleTtlMs must be a scalar value.");
      settings.adapters = { multica: { staleTtlMs: unquoteScalar(value) } };
      continue;
    }

    throw new Error(`Unsupported settings YAML line: ${withoutComment.trim()}`);
  }

  return { present: foundSettings, settings };
}

export const daemonRuntimeKeys = [
  "writeLockTtlMs", "interactiveMicroBatchMs", "maxInteractiveOpsPerCommit",
  "materializerPollMs", "materializerMaxBranchesPerBatch",
  "projectionReconcileIntervalMs", "registryReconcileIntervalMs"
] as const satisfies ReadonlyArray<keyof DaemonRuntimePolicyValues>;

function isKnownSettingsScalar(key: string): boolean {
  return key === "locale" || key === "defaultVertical" || key === "defaultPreset" || key === "defaultProfile";
}

function unquoteScalar(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
