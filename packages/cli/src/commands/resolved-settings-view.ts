import {
  landedSettingsRegistry,
  type HarnessLayoutInput,
  type LandedSettingDefinition,
  type LandedSettingSource
} from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import type { CliResult } from "../cli/types.ts";
import { readProjectHarnessSettings, type ProjectHarnessSettings } from "./settings.ts";

export interface ResolvedSettingRow {
  readonly key: string;
  readonly cluster: LandedSettingDefinition["cluster"];
  readonly value: number | string | null;
  readonly source: LandedSettingSource;
  readonly unit: LandedSettingDefinition["unit"];
  readonly env: string;
  readonly yaml?: string;
  readonly flag?: string;
  readonly overrideChain: string;
}

type ResolvedSettingsView =
  | { readonly ok: true; readonly rows: ReadonlyArray<ResolvedSettingRow> }
  | { readonly ok: false; readonly result: CliResult };

export function resolveSettingsView(
  rootInput: HarnessLayoutInput,
  env: NodeJS.ProcessEnv = process.env
): ResolvedSettingsView {
  const project = readProjectHarnessSettings(rootInput, "doctor");
  if (!project.ok) return project;
  try {
    return {
      ok: true,
      rows: landedSettingsRegistry.map((definition) => resolveDefinition(definition, project.settings, env))
    };
  } catch (error) {
    return {
      ok: false,
      result: {
        ok: false,
        command: "doctor",
        error: cliError(CliErrorCode.HarnessSettingsInvalid, error instanceof Error ? error.message : String(error))
      }
    };
  }
}

function resolveDefinition(
  definition: LandedSettingDefinition,
  settings: ProjectHarnessSettings,
  env: NodeJS.ProcessEnv
): ResolvedSettingRow {
  const rawEnv = env[definition.env];
  const envIsSet = rawEnv !== undefined && !(definition.emptyEnvironmentIsUnset && rawEnv === "");
  const yamlValue = definition.yamlPath ? nestedValue(settings, definition.yamlPath) : undefined;
  const source: LandedSettingSource = envIsSet ? "env" : yamlValue !== undefined ? "yaml" : "default";
  const rawValue = envIsSet
    ? parseEnvironmentValue(definition, rawEnv)
    : typeof yamlValue === "number" || typeof yamlValue === "string"
      ? yamlValue
      : definition.defaultValue;
  return {
    key: definition.key,
    cluster: definition.cluster,
    value: rawValue ?? null,
    source,
    unit: definition.unit,
    env: definition.env,
    ...(definition.yamlPath ? { yaml: `settings.${definition.yamlPath.join(".")}` } : {}),
    ...(definition.flag ? { flag: definition.flag } : {}),
    overrideChain: definition.overrideChain.join(" < ")
  };
}

function parseEnvironmentValue(definition: LandedSettingDefinition, raw: string | undefined): number | string {
  if (raw === undefined) throw new Error(`${definition.env} is unavailable.`);
  if (definition.unit === "url") {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.username || parsed.password) {
      throw new Error(`${definition.env} must use an explicit 127.0.0.1 HTTP port.`);
    }
    return raw;
  }
  const normalized = raw.trim();
  if (!/^[0-9]+$/u.test(normalized)) throw new Error(`${definition.env} must be an integer in ${definition.unit}.`);
  const parsed = Number(normalized);
  const minimum = definition.minimum ?? 1;
  const maximum = definition.maximum ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${definition.env} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function nestedValue(root: ProjectHarnessSettings, segments: ReadonlyArray<string>): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (!isResolvedSettingsRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function isResolvedSettingsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
