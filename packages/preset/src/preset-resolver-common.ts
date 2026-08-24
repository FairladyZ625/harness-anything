import type { PresetFailure } from "./preset-resolver-types.ts";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const defaultAssets = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../assets/software-coding",
  ),
  defaultBundled = path.join(defaultAssets, "presets");

export function resolverContentHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function key(verticalId: string, id: string): string {
  return `${verticalId}\0${id}`;
}

export function isWithinPresetAssetRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

export function presetFailure(
  code: string,
  message: string,
  missingProviderIds?: readonly string[],
): PresetFailure {
  return Object.defineProperties(new Error(message), {
    code: { value: code, enumerable: true },
    message: { value: message, enumerable: true },
    ...(missingProviderIds
      ? {
          missingProviderIds: {
            value: [...new Set(missingProviderIds)].sort(),
            enumerable: true,
          },
        }
      : {}),
  }) as unknown as PresetFailure;
}

export function asFailure(error: unknown): PresetFailure {
  return error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error
    ? (error as PresetFailure)
    : presetFailure(
        "invalid_package",
        error instanceof Error ? error.message : String(error),
      );
}

export function isPresetResolutionRecord(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw presetFailure("invalid_command", `${field} is required.`);
  return value;
}

export function normalizeLocale(value: string): "zh-CN" | "en-US" {
  return value === "zh-CN" ? "zh-CN" : "en-US";
}

export function compareVersion(left: string, right: string): number {
  const a = left.split(".").map(Number),
    b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1)
    if ((a[index] ?? 0) !== (b[index] ?? 0))
      return (a[index] ?? 0) > (b[index] ?? 0) ? 1 : -1;
  return 0;
}
