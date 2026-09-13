import { settingBlockValue } from "../layout/harness-settings.ts";
import { setting } from "../layout/harness-settings.ts";

function replaceScalar(body: string, indent: string, key: string, value: string): string {
  const line = new RegExp(`^(${indent}${key}:[^\\S\\r\\n]*)[^#\\r\\n]*?([^\\S\\r\\n]*(?:#[^\\r\\n]*)?)$`, "mu");
  if (!line.test(body)) throw new Error(`Missing ${key} in harness.yaml settings facet.`);
  return body.replace(line, `$1${value}$2`);
}

export function replaceDefaultedScalar(
  body: string,
  indent: string,
  key: string,
  value: string,
  fallback: string,
): string {
  if (setting(body, key) === undefined && value === fallback) return body;
  return replaceScalar(body, indent, key, value);
}

export function replaceOptionalDefaultedScalar(
  body: string,
  indent: string,
  key: string,
  value: string,
  fallback: string,
): string {
  if (setting(body, key) !== undefined) return replaceScalar(body, indent, key, value);
  if (value === fallback) return body;
  const header = /^settings:[^\r\n]*(?:\r?\n|$)/mu;
  if (!header.test(body)) throw new Error("Missing settings block in harness.yaml.");
  return body.replace(header, (match) => `${match}${indent}${key}: ${value}\n`);
}

export function replaceDefaultedBlockScalar(
  body: string,
  block: string,
  key: string,
  value: string,
  fallback: string,
): string {
  if (settingBlockValue(body, block, key) === undefined && value === fallback) return body;
  const section = new RegExp(`(^  ${block}:[^\\S\\r\\n]*(?:\\r?\\n))((?:    [^\\r\\n]*(?:\\r?\\n|$))*)`, "mu");
  const match = section.exec(body);
  if (!match) throw new Error(`Missing ${block} block in harness.yaml settings facet.`);
  const replaced = replaceScalar(match[2]!, "    ", key, value);
  return `${body.slice(0, match.index)}${match[1]}${replaced}${body.slice(match.index + match[0].length)}`;
}

export const closeoutProfiles = ["standard", "strict"] as const;
export type CloseoutProfile = (typeof closeoutProfiles)[number];
export const closeoutOverrideKeys = ["review", "consent", "factDisposition", "codeDoc"] as const;
export type CloseoutOverrideKey = (typeof closeoutOverrideKeys)[number];
export type CloseoutOverridesV1 = Readonly<Partial<Record<CloseoutOverrideKey, boolean>>>;
export interface CloseoutSettingsV1 {
  readonly profile: CloseoutProfile;
  readonly overrides?: CloseoutOverridesV1;
}
export type CloseoutGate = CloseoutOverrideKey;

export const DEFAULT_CLOSEOUT_SETTINGS: CloseoutSettingsV1 = Object.freeze({ profile: "standard" });

export function effectiveCloseoutGates(
  closeout: CloseoutSettingsV1,
  taskGateIds: readonly string[] = [],
): Readonly<Record<CloseoutGate, boolean>> {
  const baseline = closeout.profile === "strict";
  return Object.freeze({
    review: closeout.overrides?.review ?? baseline,
    consent: closeout.overrides?.consent ?? baseline,
    factDisposition: closeout.overrides?.factDisposition ?? baseline,
    codeDoc: (closeout.overrides?.codeDoc ?? baseline) || taskGateIds.includes("code-doc-reconciliation"),
  });
}

export function isValidCloseoutGateRecord(value: unknown): value is Readonly<Record<CloseoutGate, boolean>> {
  return (
    typeof value === "object" &&
    value !== null &&
    closeoutOverrideKeys.every((key) => typeof (value as Record<CloseoutGate, unknown>)[key] === "boolean")
  );
}

export function readCloseoutSettings(body: string): CloseoutSettingsV1 {
  const profile = settingBlockValue(body, "closeout", "profile");
  if (profile === undefined) return DEFAULT_CLOSEOUT_SETTINGS;
  if (!closeoutProfiles.includes(profile as CloseoutProfile))
    throw new Error(`settings.closeout.profile must be one of ${closeoutProfiles.join(", ")}`);
  const section = /^  closeout:[^\S\r\n]*(?:\r?\n)((?:(?:    |      )[^\r\n]*(?:\r?\n|$))*)/mu.exec(body)?.[1] ?? "";
  const overrides = Object.fromEntries(
    closeoutOverrideKeys.flatMap((key) => {
      const raw = new RegExp(`^      ${key}:[^\\S\\r\\n]*([^#\\r\\n]*?)\\s*(?:#.*)?$`, "mu").exec(section)?.[1]?.trim();
      if (raw === undefined) return [];
      if (raw !== "true" && raw !== "false") throw new Error(`settings.closeout.overrides.${key} must be boolean`);
      return [[key, raw === "true"]];
    }),
  ) as CloseoutOverridesV1;
  return { profile: profile as CloseoutProfile, ...(Object.keys(overrides).length ? { overrides } : {}) };
}

export function writeCloseoutFacet(body: string, closeout: CloseoutSettingsV1): string {
  const section = /^  closeout:[^\S\r\n]*(?:\r?\n)(?:(?:    |      )[^\r\n]*(?:\r?\n|$))*/mu,
    isDefault = JSON.stringify(closeout) === JSON.stringify(DEFAULT_CLOSEOUT_SETTINGS);
  if (!section.test(body) && isDefault) return body;
  const overrideLines = closeoutOverrideKeys.flatMap((key) =>
      closeout.overrides?.[key] === undefined ? [] : [`      ${key}: ${closeout.overrides[key]}`],
    ),
    rendered = [
      "  closeout:",
      `    profile: ${closeout.profile}`,
      ...(overrideLines.length ? ["    overrides:", ...overrideLines] : []),
      "",
    ].join("\n");
  if (section.test(body)) return body.replace(section, rendered);
  const header = /^settings:[^\r\n]*(?:\r?\n|$)/mu;
  if (!header.test(body)) throw new Error("Missing settings block in harness.yaml.");
  return body.replace(header, (match) => `${match}${rendered}`);
}
