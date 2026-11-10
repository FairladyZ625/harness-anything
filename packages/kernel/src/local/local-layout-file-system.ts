import {
  constants,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
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
  cloneMode: constants.COPYFILE_FICLONE,
  copy: cpSync,
  exists: existsSync,
  lstat: lstatSync,
  makeTemporaryDirectory: mkdtempSync,
  mkdir: mkdirSync,
  read: readFileSync,
  readChunk: readSync,
  readDirectory: readdirSync,
  readLink: readlinkSync,
  stat: statSync,
  symlink: symlinkSync,
  write: writeFileSync,
  remove: (inputPath: string) =>
    /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
    rmSync(inputPath, { recursive: true, force: true }),
} as const;

export const localEventFileSystem = {
  exists: (inputPath: string) => existsSync(inputPath),
  readText: (inputPath: string) => readFileSync(inputPath, "utf8"),
  readNames: (inputPath: string) => readdirSync(inputPath),
  realpath: (inputPath: string) => realpathSync.native(inputPath),
  remove: (inputPath: string) =>
    /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
    rmSync(inputPath, { force: true }),
};

export const localRuntimeStateFileSystem = {
  createExclusiveText: (inputPath: string, value: string | Uint8Array, syncParents = true): boolean => {
    let descriptor: number;
    try {
      descriptor =
        /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
        openSync(inputPath, "wx");
    } catch (error) {
      if (isExclusiveCreateConflict(error)) return false;
      throw error;
    }
    try {
      /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
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
      /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
      closeSync(descriptor);
    }
  },
  exists: (inputPath: string) => existsSync(inputPath),
  fileIdentity: (inputPath: string) => {
    const stat = statSync(inputPath, { throwIfNoEntry: false });
    return stat === undefined ? null : `${stat.dev}:${stat.ino}`;
  },
  fileSize: (inputPath: string) => {
    const stat = statSync(inputPath, { throwIfNoEntry: false });
    return stat?.size ?? null;
  },
  mkdirp: (inputPath: string) =>
    /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
    mkdirSync(inputPath, { recursive: true }),
  linkExclusive: (fromPath: string, toPath: string): void => {
    /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
    linkSync(fromPath, toPath);
  },
  modifiedAtMs: (inputPath: string) => statSync(inputPath).mtimeMs,
  readText: (inputPath: string) => readFileSync(inputPath, "utf8"),
  rename: (fromPath: string, toPath: string) =>
    /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
    renameSync(fromPath, toPath),
  remove: (inputPath: string) =>
    /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
    rmSync(inputPath, { force: true }),
  syncDirectory: (inputPath: string) => syncDirectories([inputPath]),
  withReadDescriptor: <T>(inputPath: string, use: (descriptor: number) => T): T => {
    const descriptor =
      /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
      openSync(inputPath, "r");
    try {
      return use(descriptor);
    } finally {
      /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
      closeSync(descriptor);
    }
  },
  writeExclusiveStream: (inputPath: string, chunks: Iterable<string | Uint8Array>): void => {
    const descriptor =
      /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
      openSync(inputPath, "wx");
    try {
      for (const chunk of chunks) {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        for (let offset = 0; offset < bytes.byteLength; )
          offset +=
            /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
            writeSync(descriptor, bytes, offset);
      }
    } finally {
      /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
      closeSync(descriptor);
    }
  },
  writeText: (inputPath: string, value: string) =>
    /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
    writeFileSync(inputPath, value, "utf8"),
};

// Required content objects and their directory links are durable before SQLite accepts a command.
export const localContentObjectFileSystem = {
  readNames: (inputPath: string) => readdirSync(inputPath),
  exists: (inputPath: string) => existsSync(inputPath),
  readBytes: (inputPath: string): Uint8Array => readFileSync(inputPath),
  sizeBytes: (inputPath: string) => statSync(inputPath).size,
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
        /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
        mkdirSync(path.dirname(entry.path), { recursive: true });
        const temporary = `${entry.path}.${process.pid}.tmp`,
          descriptor =
            /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
            openSync(temporary, "w", 0o600);
        temporaryObjects.push({ temporary, target: entry.path });
        try {
          /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
          writeSync(descriptor, typeof entry.body === "string" ? Buffer.from(entry.body, "utf8") : entry.body);
          syncDescriptor(descriptor);
        } finally {
          /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
          closeSync(descriptor);
        }
      }
      for (const object of temporaryObjects) {
        /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
        renameSync(object.temporary, object.target);
      }
      syncDirectories([...directories]);
    } catch (error) {
      for (const object of temporaryObjects) {
        /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
        rmSync(object.temporary, { force: true });
      }
      throw error;
    }
  },
};

function syncDescriptor(descriptor: number): void {
  /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
  fsyncSync(descriptor);
}

function syncDirectories(directories: readonly string[]): void {
  if (process.platform !== "win32")
    for (const directoryPath of directories) {
      const directory =
        /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
        openSync(directoryPath, "r");
      try {
        /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
        fsyncSync(directory);
      } finally {
        /* @gate-identity state-store/document.source.kernel.src.local.local-layout-file-system.filesystem-store */
        closeSync(directory);
      }
    }
}

function isExclusiveCreateConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
