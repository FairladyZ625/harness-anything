import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
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

export const localEventFileSystem = {
  exists: (inputPath: string) => existsSync(inputPath), readText: (inputPath: string) => readFileSync(inputPath, "utf8"),
  readNames: (inputPath: string) => readdirSync(inputPath), realpath: (inputPath: string) => realpathSync.native(inputPath),
  remove: (inputPath: string) => rmSync(inputPath, { force: true }),
  writeDurably: (inputPath: string, body: string): number => {
    mkdirSync(path.dirname(inputPath), { recursive: true }); const tempPath = `${inputPath}.${process.pid}.tmp`; const fd = openSync(tempPath, "w");
    try { writeSync(fd, body, null, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tempPath, inputPath); if (process.platform === "win32") return 1;
    const dir = openSync(path.dirname(inputPath), "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
    return 2;
  }
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
