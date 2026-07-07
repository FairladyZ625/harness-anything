import { readdirSync, readFileSync, statSync } from "node:fs";
import type { Dirent, Stats } from "node:fs";

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

function isVanishedPathError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}
