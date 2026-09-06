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
      syncDescriptor(descriptor);
      const directories = [path.dirname(inputPath)];
      while (path.dirname(directories.at(-1)!) !== directories.at(-1))
        directories.push(path.dirname(directories.at(-1)!));
      syncDirectories(directories);
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

// Required content objects and their directory links are durable before SQLite accepts a command.
export const localContentObjectFileSystem = {
  readNames: (inputPath: string) => readdirSync(inputPath),
  exists: (inputPath: string) => existsSync(inputPath),
  readText: (inputPath: string) => readFileSync(inputPath, "utf8"),
  replace: (inputPath: string, body: string): void => {
    const directories = [path.dirname(inputPath)];
    while (!existsSync(directories.at(-1)!)) {
      const parent = path.dirname(directories.at(-1)!);
      if (parent === directories.at(-1)) break;
      directories.push(parent);
    }
    /* @gate-identity check-bypass-write-boundary/bypass-write-067 */
    mkdirSync(path.dirname(inputPath), { recursive: true });
    const temporary = `${inputPath}.${process.pid}.tmp`;
    const descriptor =
      /* @gate-identity check-bypass-write-boundary/bypass-write-068 */
      openSync(temporary, "w", 0o600);
    // A failed write owns and removes only its temporary object.
    try {
      try {
        /* @gate-identity check-bypass-write-boundary/bypass-write-069 */
        writeSync(descriptor, body, null, "utf8");
        syncDescriptor(descriptor);
      } finally {
        /* @gate-identity check-bypass-write-boundary/bypass-write-071 */
        closeSync(descriptor);
      }
      /* @gate-identity check-bypass-write-boundary/bypass-write-072 */
      renameSync(temporary, inputPath);
    } catch (error) {
      /* @gate-identity check-bypass-write-boundary/bypass-write-110 */
      rmSync(temporary, { force: true });
      throw error;
    }
    syncDirectories(directories);
  },
};

function syncDescriptor(descriptor: number): void {
  /* @gate-identity check-bypass-write-boundary/bypass-write-070 */
  fsyncSync(descriptor);
}

function syncDirectories(directories: readonly string[]): void {
  if (process.platform !== "win32")
    for (const directoryPath of directories) {
      const directory =
        /* @gate-identity check-bypass-write-boundary/bypass-write-073 */
        openSync(directoryPath, "r");
      try {
        /* @gate-identity check-bypass-write-boundary/bypass-write-074 */
        fsyncSync(directory);
      } finally {
        /* @gate-identity check-bypass-write-boundary/bypass-write-075 */
        closeSync(directory);
      }
    }
}

function isExclusiveCreateConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
