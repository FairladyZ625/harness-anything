import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import {
  hostEnvironmentFiles,
  hostScratchPrefixes,
} from "@harness-anything/kernel/internal/domain/host-environment-io.ts";

export function hostEnvironmentFilePath(kind: keyof typeof hostEnvironmentFiles, directory: string): string {
  return path.join(directory, hostEnvironmentFiles[kind].name);
}

const WINDOWS_TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * Windows NTFS `MoveFileExW` returns transient `EPERM`/`EACCES`/`EBUSY` when concurrent
 * readers or writers hold a handle on the destination path. Retry briefly with bounded
 * backoff only on `win32` and never mask a destination-directory collision.
 */
async function retryWindowsTransientRename(target: string, performRename: () => Promise<void>): Promise<void> {
  if (process.platform !== "win32") {
    await performRename();
    return;
  }
  const deadline = Date.now() + storageReadPolicy.defaultValue.deadlines.openBusy,
    retryDelayMs = storageReadPolicy.defaultValue.backoff.openBusy;
  for (;;) {
    const renameError = await performRename().then(
      () => null,
      (error: unknown) => error,
    );
    if (renameError === null) return;
    if (statSync(target, { throwIfNoEntry: false })?.isDirectory()) throw renameError;
    const code = (renameError as NodeJS.ErrnoException).code;
    if (!code || !WINDOWS_TRANSIENT_RENAME_CODES.has(code) || Date.now() >= deadline) throw renameError;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
}

/** Publish a host checkpoint with one rename in its owning directory. */
export async function writeHostEnvironmentFile(
  kind: keyof typeof hostEnvironmentFiles,
  directory: string,
  contents: string,
): Promise<void> {
  const target = hostEnvironmentFilePath(kind, directory),
    temporary = `${target}.${randomUUID()}.tmp`,
    handle = await open(temporary, "wx", 0o600);
  let published = false;
  try {
    await writeFile(handle, contents, "utf8").finally(() => handle.close());
    await retryWindowsTransientRename(target, () => rename(temporary, target));
    published = true;
  } finally {
    if (!published) await rm(temporary, { force: true });
  }
}

/** Open a staged streaming line writer for a caller-specified export artifact path.
 *  Writes to a sibling temporary file and publishes via a single atomic switch:
 *  when publishing a companion manifest alongside a content-addressed entries target,
 *  the immutable entries file is staged first without overwriting any prior entries file,
 *  then the companion manifest is switched atomically in one POSIX rename. Previously
 *  referenced content-addressed entries files are retained so concurrent readers never hit
 *  ENOENT and a corrupted prior manifest cannot trigger deletion of unrelated files. */
export async function openCallerOutputLineWriter(filePath: string): Promise<{
  readonly writeLine: (line: string) => Promise<void>;
  readonly commit: (companion?: {
    readonly filePath: string;
    readonly contents: string;
    readonly entriesTargetPath?: string;
    readonly beforeSwitch?: () => void | Promise<void>;
  }) => Promise<void>;
  readonly abort: () => Promise<void>;
  readonly close: () => Promise<void>;
}> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const temporary = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let closed = false;
  let published = false;
  let cleaned = false;
  const closeHandle = async () => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  const cleanupTemp = async () => {
    if (cleaned || published) return;
    cleaned = true;
    await rm(temporary, { force: true });
  };
  const publishEntries = (targetPath: string) =>
    retryWindowsTransientRename(targetPath, () => rename(temporary, targetPath));
  return {
    writeLine: async (line: string) => {
      await handle.write(line, undefined, "utf8");
    },
    commit: async (companion) => {
      await closeHandle();
      if (published) return;
      if (companion === undefined) {
        await publishEntries(filePath);
        published = true;
        return;
      }
      const finalEntriesPath = companion.entriesTargetPath ?? filePath;
      const stagedCompanion = await openCallerOutputLineWriter(companion.filePath);
      let companionCommitted = false;
      try {
        await stagedCompanion.writeLine(companion.contents);
        await publishEntries(finalEntriesPath);
        // Once the private staging file has been renamed to the shared content-addressed target,
        // NEVER delete that target on subsequent manifest-switch failure: a concurrent publisher
        // writing identical content may already reference it from a committed manifest.
        published = true;
        if (companion.beforeSwitch !== undefined) {
          await companion.beforeSwitch();
        }
        await stagedCompanion.commit();
        companionCommitted = true;
      } finally {
        if (!companionCommitted) {
          await stagedCompanion.abort();
        }
        await stagedCompanion.close();
      }
    },
    abort: async () => {
      try {
        await closeHandle();
      } finally {
        await cleanupTemp();
      }
    },
    close: async () => {
      try {
        await closeHandle();
      } finally {
        if (!published) await cleanupTemp();
      }
    },
  };
}

/** Atomically write a single caller-specified export artifact file, creating parent directories if needed. */
export async function writeCallerOutputFile(filePath: string, contents: string | Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const temporary = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let published = false;
  try {
    await writeFile(handle, contents, typeof contents === "string" ? "utf8" : undefined).finally(() => handle.close());
    await retryWindowsTransientRename(filePath, () => rename(temporary, filePath));
    published = true;
  } finally {
    if (!published) await rm(temporary, { force: true });
  }
}

/** Cleanup can only name the directory this call acquired. */
export function createHostScratchDirectory(kind: keyof typeof hostScratchPrefixes): {
  readonly directory: string;
  readonly close: () => void;
} {
  const directory = mkdtempSync(path.join(tmpdir(), hostScratchPrefixes[kind]));
  let closed = false;
  return {
    directory,
    close: () => {
      if (closed) return;
      rmSync(directory, { recursive: true, force: true });
      closed = true;
    },
  };
}
