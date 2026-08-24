import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { LayoutFileSystem } from "../layout/file-system.ts";

export const localLayoutFileSystem: LayoutFileSystem = {
  exists: (inputPath) => existsSync(inputPath),
  readText: (inputPath) => readFileSync(inputPath, "utf8"),
  readDirents: (inputPath) => readdirSync(inputPath, { withFileTypes: true }),
};

export const localEvidenceFileSystem = {
  exists: (inputPath: string) => existsSync(inputPath),
  readBytes: (inputPath: string): Uint8Array => readFileSync(inputPath),
  realpath: (inputPath: string) => realpathSync(inputPath),
};

export const localEventFileSystem = {
  exists: (inputPath: string) => existsSync(inputPath),
  readText: (inputPath: string) => readFileSync(inputPath, "utf8"),
  readNames: (inputPath: string) => readdirSync(inputPath),
  realpath: (inputPath: string) => realpathSync.native(inputPath),
  remove: (inputPath: string) =>
    /* @gate-identity check-bypass-write-boundary/bypass-write-043 */
    rmSync(inputPath, { force: true }),
  writeDurably: (inputPath: string, body: string): number => {
    /* @gate-identity check-bypass-write-boundary/bypass-write-044 */
    mkdirSync(path.dirname(inputPath), { recursive: true });
    const tempPath = `${inputPath}.${process.pid}.tmp`;
    const fd =
      /* @gate-identity check-bypass-write-boundary/bypass-write-045 */
      openSync(tempPath, "w");
    try {
      /* @gate-identity check-bypass-write-boundary/bypass-write-046 */
      writeSync(fd, body, null, "utf8");
      /* @gate-identity check-bypass-write-boundary/bypass-write-047 */
      fsyncSync(fd);
    } finally {
      /* @gate-identity check-bypass-write-boundary/bypass-write-048 */
      closeSync(fd);
    }
    /* @gate-identity check-bypass-write-boundary/bypass-write-049 */
    renameSync(tempPath, inputPath);
    if (process.platform === "win32") return 1;
    const dir =
      /* @gate-identity check-bypass-write-boundary/bypass-write-050 */
      openSync(path.dirname(inputPath), "r");
    try {
      /* @gate-identity check-bypass-write-boundary/bypass-write-051 */
      fsyncSync(dir);
    } finally {
      /* @gate-identity check-bypass-write-boundary/bypass-write-052 */
      closeSync(dir);
    }
    return 2;
  },
};

export const localRuntimeStateFileSystem = {
  createExclusiveText: (inputPath: string, value: string): boolean => {
    let descriptor: number;
    try {
      descriptor =
        /* @gate-identity check-bypass-write-boundary/bypass-write-053 */
        openSync(inputPath, "wx");
    } catch (error) {
      if (isExclusiveCreateConflict(error)) return false;
      throw error;
    }
    try {
      /* @gate-identity check-bypass-write-boundary/bypass-write-054 */
      writeFileSync(descriptor, value, "utf8");
      return true;
    } finally {
      /* @gate-identity check-bypass-write-boundary/bypass-write-055 */
      closeSync(descriptor);
    }
  },
  exists: (inputPath: string) => existsSync(inputPath),
  fileIdentity: (inputPath: string) => {
    const stat = statSync(inputPath, { throwIfNoEntry: false });
    return stat === undefined ? null : `${stat.dev}:${stat.ino}`;
  },
  mkdirp: (inputPath: string) =>
    /* @gate-identity check-bypass-write-boundary/bypass-write-056 */
    mkdirSync(inputPath, { recursive: true }),
  modifiedAtMs: (inputPath: string) => statSync(inputPath).mtimeMs,
  readText: (inputPath: string) => readFileSync(inputPath, "utf8"),
  rename: (fromPath: string, toPath: string) =>
    /* @gate-identity check-bypass-write-boundary/bypass-write-057 */
    renameSync(fromPath, toPath),
  remove: (inputPath: string) =>
    /* @gate-identity check-bypass-write-boundary/bypass-write-058 */
    rmSync(inputPath, { force: true }),
  writeText: (inputPath: string, value: string) =>
    /* @gate-identity check-bypass-write-boundary/bypass-write-059 */
    writeFileSync(inputPath, value, "utf8"),
};

// An acknowledged write is durable only after its WAL segment, head, and content
// objects have crossed this fsync boundary.
export const localWalFileSystem = {
  exists: (inputPath: string) => existsSync(inputPath),
  mkdirp: (inputPath: string) =>
    /* @gate-identity check-bypass-write-boundary/bypass-write-060 */
    mkdirSync(inputPath, { recursive: true }),
  readNames: (inputPath: string) => readdirSync(inputPath),
  readText: (inputPath: string) => readFileSync(inputPath, "utf8"),
  remove: (inputPath: string): void =>
    /* @gate-identity check-bypass-write-boundary/bypass-write-061 */
    rmSync(inputPath, { force: true }),
  append: (inputPath: string, body: string): void => {
    /* @gate-identity check-bypass-write-boundary/bypass-write-062 */
    mkdirSync(path.dirname(inputPath), { recursive: true });
    const descriptor =
      /* @gate-identity check-bypass-write-boundary/bypass-write-063 */
      openSync(inputPath, "a", 0o600);
    try {
      /* @gate-identity check-bypass-write-boundary/bypass-write-064 */
      writeSync(descriptor, body, null, "utf8");
      /* @gate-identity check-bypass-write-boundary/bypass-write-065 */
      fsyncSync(descriptor);
    } finally {
      /* @gate-identity check-bypass-write-boundary/bypass-write-066 */
      closeSync(descriptor);
    }
  },
  replace: (inputPath: string, body: string): void => {
    /* @gate-identity check-bypass-write-boundary/bypass-write-067 */
    mkdirSync(path.dirname(inputPath), { recursive: true });
    const temporary = `${inputPath}.${process.pid}.tmp`;
    const descriptor =
      /* @gate-identity check-bypass-write-boundary/bypass-write-068 */
      openSync(temporary, "w", 0o600);
    try {
      /* @gate-identity check-bypass-write-boundary/bypass-write-069 */
      writeSync(descriptor, body, null, "utf8");
      /* @gate-identity check-bypass-write-boundary/bypass-write-070 */
      fsyncSync(descriptor);
    } finally {
      /* @gate-identity check-bypass-write-boundary/bypass-write-071 */
      closeSync(descriptor);
    }
    /* @gate-identity check-bypass-write-boundary/bypass-write-072 */
    renameSync(temporary, inputPath);
    if (process.platform !== "win32") {
      const directory =
        /* @gate-identity check-bypass-write-boundary/bypass-write-073 */
        openSync(path.dirname(inputPath), "r");
      try {
        /* @gate-identity check-bypass-write-boundary/bypass-write-074 */
        fsyncSync(directory);
      } finally {
        /* @gate-identity check-bypass-write-boundary/bypass-write-075 */
        closeSync(directory);
      }
    }
  },
};

function isExclusiveCreateConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
