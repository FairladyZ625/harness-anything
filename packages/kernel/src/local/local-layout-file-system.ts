import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { LayoutFileSystem } from "../layout/file-system.ts";

export const localLayoutFileSystem: LayoutFileSystem = {
  exists: (inputPath) => existsSync(inputPath),
  readText: (inputPath) => readFileSync(inputPath, "utf8"),
  readDirents: (inputPath) => readdirSync(inputPath, { withFileTypes: true })
};

export const localEvidenceFileSystem = {
  exists: (inputPath: string) => existsSync(inputPath),
  readBytes: (inputPath: string): Uint8Array => readFileSync(inputPath),
  realpath: (inputPath: string) => realpathSync(inputPath)
};

export const localProjectionSourceFileSystem = {
  readStableDirents: (inputPath: string): { readonly entries: ReadonlyArray<Dirent<string>>; readonly signature: string } => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = projectionSourceStatSignature(inputPath);
      const entries = readdirSync(inputPath, { withFileTypes: true });
      const after = projectionSourceStatSignature(inputPath);
      if (before !== null && before === after) return { entries, signature: after };
    }
    throw new Error(`projection source directory did not stabilize: ${inputPath}`);
  },
  readStableText: (inputPath: string): { readonly body: string; readonly signature: string } => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = projectionSourceStatSignature(inputPath);
      const body = readFileSync(inputPath, "utf8");
      const after = projectionSourceStatSignature(inputPath);
      if (before !== null && before === after) return { body, signature: after };
    }
    throw new Error(`projection source file did not stabilize: ${inputPath}`);
  },
  statSignature: (inputPath: string): string | null => {
    return projectionSourceStatSignature(inputPath);
  }
};

export function listProjectionSourceDirectoryPaths(rootPath: string): ReadonlyArray<string> {
  try {
    if (!statSync(rootPath).isDirectory()) return [];
    return [rootPath, ...readdirSync(rootPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules")
      .flatMap((entry) => listProjectionSourceDirectoryPaths(path.join(rootPath, entry.name)))];
  } catch {
    return [];
  }
}

function projectionSourceStatSignature(inputPath: string): string | null {
  try {
    const stats = statSync(inputPath, { bigint: true });
    return [stats.dev, stats.ino, stats.mode, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
  } catch {
    return null;
  }
}

export const localRuntimeStateFileSystem = {
  createExclusiveText: (inputPath: string, value: string): boolean => {
    let descriptor: number;
    try {
      descriptor = openSync(inputPath, "wx");
    } catch (error) {
      if (isExclusiveCreateConflict(error)) return false;
      throw error;
    }
    try {
      writeFileSync(descriptor, value, "utf8");
      return true;
    } finally {
      closeSync(descriptor);
    }
  },
  exists: (inputPath: string) => existsSync(inputPath),
  mkdirp: (inputPath: string) => mkdirSync(inputPath, { recursive: true }),
  modifiedAtMs: (inputPath: string) => statSync(inputPath).mtimeMs,
  readText: (inputPath: string) => readFileSync(inputPath, "utf8"),
  rename: (fromPath: string, toPath: string) => renameSync(fromPath, toPath),
  remove: (inputPath: string) => rmSync(inputPath, { force: true }),
  writeText: (inputPath: string, value: string) => writeFileSync(inputPath, value, "utf8")
};

function isExclusiveCreateConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
