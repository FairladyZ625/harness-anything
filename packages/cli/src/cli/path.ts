import { realpathSync } from "node:fs";
import path from "node:path";

export function relativePath(rootDir: string, filePath: string): string {
  return normalizeSlashes(path.relative(rootDir, filePath));
}

export function normalizeSlashes(value: string): string {
  return value.split(path.sep).join("/");
}

export function canonicalPath(target: string): string {
  const resolved = path.resolve(target);
  let current = resolved;
  let suffix = "";
  while (true) {
    try {
      const real = realpathSync(current);
      return suffix ? path.join(real, suffix) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      suffix = suffix ? path.join(path.basename(current), suffix) : path.basename(current);
      current = parent;
    }
  }
}

export function isSamePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(canonicalPath(parent), canonicalPath(candidate));
  return relative === "" || isSafeRelativePath(relative);
}

export function isGeneratedOrVendorPath(relativePath: string): boolean {
  const normalized = normalizeSlashes(relativePath);
  const segments = normalized.split("/");
  return segments.includes("node_modules")
    || segments.includes(".git")
    || segments.includes(".next")
    || segments.includes(".turbo")
    || segments.includes("dist")
    || segments.includes("build")
    || segments.includes("coverage")
    || normalized === ".harness/generated"
    || normalized.startsWith(".harness/generated/")
    || normalized === "harness/legacy"
    || normalized.startsWith("harness/legacy/");
}

function isSafeRelativePath(relative: string): boolean {
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function isSafeBodyPath(value: string): boolean {
  if (path.isAbsolute(value) || value.includes("\\") || !value.endsWith(".md")) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}
