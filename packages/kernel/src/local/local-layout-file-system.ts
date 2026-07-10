import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { LayoutFileSystem } from "../layout/file-system.ts";

export const localLayoutFileSystem: LayoutFileSystem = {
  exists: (inputPath) => existsSync(inputPath),
  readText: (inputPath) => readFileSync(inputPath, "utf8"),
  readDirents: (inputPath) => readdirSync(inputPath, { withFileTypes: true })
};

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
