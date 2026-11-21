import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hostEnvironmentFiles,
  hostScratchPrefixes,
} from "@harness-anything/kernel/internal/domain/host-environment-io.ts";

export function hostEnvironmentFilePath(kind: keyof typeof hostEnvironmentFiles, directory: string): string {
  return path.join(directory, hostEnvironmentFiles[kind].name);
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
    await rename(temporary, target);
    published = true;
  } finally {
    if (!published) await rm(temporary, { force: true });
  }
}

/** Open a staged streaming line writer for a caller-specified export artifact path.
 *  Writes to a sibling temporary file and publishes atomically only on commit()
 *  (optionally staging a companion file such as audit-manifest.json before either
 *  rename), leaving pre-existing targets untouched if aborted or failed mid-stream. */
export async function openCallerOutputLineWriter(filePath: string): Promise<{
  readonly writeLine: (line: string) => Promise<void>;
  readonly commit: (companion?: { readonly filePath: string; readonly contents: string }) => Promise<void>;
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
  return {
    writeLine: async (line: string) => {
      await handle.write(line, undefined, "utf8");
    },
    commit: async (companion) => {
      await closeHandle();
      if (published) return;
      const stagedCompanion = companion === undefined ? null : await openCallerOutputLineWriter(companion.filePath);
      let companionCommitted = false;
      try {
        if (stagedCompanion !== null && companion !== undefined) {
          await stagedCompanion.writeLine(companion.contents);
        }
        await rename(temporary, filePath);
        published = true;
        if (stagedCompanion !== null) {
          await stagedCompanion.commit();
          companionCommitted = true;
        }
      } finally {
        if (stagedCompanion !== null) {
          if (!companionCommitted) await stagedCompanion.abort();
          await stagedCompanion.close();
        }
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
export async function writeCallerOutputFile(filePath: string, contents: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const temporary = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let published = false;
  try {
    await writeFile(handle, contents, "utf8").finally(() => handle.close());
    await rename(temporary, filePath);
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
