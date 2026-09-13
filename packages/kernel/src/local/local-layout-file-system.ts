import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
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

export const localLedgerBackupFileSystem = {
  copy: cpSync,
  exists: existsSync,
  lstat: lstatSync,
  makeTemporaryDirectory: mkdtempSync,
  mkdir: mkdirSync,
  read: readFileSync,
  readDirectory: readdirSync,
  readLink: readlinkSync,
  stat: statSync,
  write: writeFileSync,
  remove: (inputPath: string) =>
    /* @gate-identity check-bypass-write-boundary/bypass-write-135 */
    rmSync(inputPath, { recursive: true, force: true }),
} as const;

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
  createExclusiveText: (inputPath: string, value: string | Uint8Array, syncParents = true): boolean => {
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
      writeFileSync(descriptor, value);
      syncDescriptor(descriptor);
      if (syncParents) {
        const directories = [path.dirname(inputPath)];
        while (path.dirname(directories.at(-1)!) !== directories.at(-1))
          directories.push(path.dirname(directories.at(-1)!));
        syncDirectories(directories);
      }
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
  syncDirectory: (inputPath: string) => syncDirectories([inputPath]),
  withReadDescriptor: <T>(inputPath: string, use: (descriptor: number) => T): T => {
    const descriptor =
      /* @gate-identity check-bypass-write-boundary/bypass-write-129 */
      openSync(inputPath, "r");
    try {
      return use(descriptor);
    } finally {
      /* @gate-identity check-bypass-write-boundary/bypass-write-130 */
      closeSync(descriptor);
    }
  },
  writeExclusiveStream: (inputPath: string, chunks: Iterable<string | Uint8Array>): void => {
    const descriptor =
      /* @gate-identity check-bypass-write-boundary/bypass-write-131 */
      openSync(inputPath, "wx");
    try {
      for (const chunk of chunks) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        for (let offset = 0; offset < bytes.byteLength; )
          offset +=
            /* @gate-identity check-bypass-write-boundary/bypass-write-132 */
            writeSync(descriptor, bytes, offset);
      }
    } finally {
      /* @gate-identity check-bypass-write-boundary/bypass-write-133 */
      closeSync(descriptor);
    }
  },
  writeText: (inputPath: string, value: string) =>
    /* @gate-identity check-bypass-write-boundary/bypass-write-059 */
    writeFileSync(inputPath, value, "utf8"),
};

// Required content objects and their directory links are durable before SQLite accepts a command.
export const localContentObjectFileSystem = {
  readNames: (inputPath: string) => readdirSync(inputPath),
  exists: (inputPath: string) => existsSync(inputPath),
  readBytes: (inputPath: string): Uint8Array => readFileSync(inputPath),
  replaceMany: (entries: readonly { readonly path: string; readonly body: string | Uint8Array }[]): void => {
    const directories = new Set<string>(),
      temporaryObjects: { readonly temporary: string; readonly target: string }[] = [];
    try {
      for (const entry of entries) {
        let directory = path.dirname(entry.path);
        directories.add(directory);
        while (!existsSync(directory)) {
          const parent = path.dirname(directory);
          if (parent === directory) break;
          directory = parent;
          directories.add(directory);
        }
        /* @gate-identity check-bypass-write-boundary/bypass-write-067 */
        mkdirSync(path.dirname(entry.path), { recursive: true });
        const temporary = `${entry.path}.${process.pid}.tmp`,
          descriptor =
            /* @gate-identity check-bypass-write-boundary/bypass-write-068 */
            openSync(temporary, "w", 0o600);
        temporaryObjects.push({ temporary, target: entry.path });
        try {
          /* @gate-identity check-bypass-write-boundary/bypass-write-069 */
          writeSync(descriptor, typeof entry.body === "string" ? Buffer.from(entry.body, "utf8") : entry.body);
          syncDescriptor(descriptor);
        } finally {
          /* @gate-identity check-bypass-write-boundary/bypass-write-071 */
          closeSync(descriptor);
        }
      }
      /* @gate-identity check-bypass-write-boundary/bypass-write-072 */
      for (const object of temporaryObjects) renameSync(object.temporary, object.target);
      syncDirectories([...directories]);
    } catch (error) {
      /* @gate-identity check-bypass-write-boundary/bypass-write-110 */
      for (const object of temporaryObjects) rmSync(object.temporary, { force: true });
      throw error;
    }
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
