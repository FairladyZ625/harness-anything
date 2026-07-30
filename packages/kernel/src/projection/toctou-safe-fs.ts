import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";

export function readTextFileIfPresent(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if (isVanishedPathError(error)) return null;
    throw error;
  }
}

export function statPathIfPresent(inputPath: string): Stats | null {
  try {
    return statSync(inputPath);
  } catch (error) {
    if (isVanishedPathError(error)) return null;
    throw error;
  }
}

export function readDirIfPresent(inputPath: string): Dirent[] | null {
  try {
    return readdirSync(inputPath, { withFileTypes: true });
  } catch (error) {
    if (isVanishedPathError(error)) return null;
    throw error;
  }
}

export function readDirNamesIfPresent(inputPath: string): string[] | null {
  try {
    return readdirSync(inputPath);
  } catch (error) {
    if (isVanishedPathError(error)) return null;
    throw error;
  }
}

export function realPathIfExists(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    const missingSegments: string[] = [];
    let existingParent = path.resolve(filePath);
    while (!existsSync(existingParent)) {
      const parent = path.dirname(existingParent);
      if (parent === existingParent) return path.resolve(filePath);
      missingSegments.unshift(path.basename(existingParent));
      existingParent = parent;
    }
    try {
      return path.join(realpathSync.native(existingParent), ...missingSegments);
    } catch {
      return path.resolve(filePath);
    }
  }
}

function isVanishedPathError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}
