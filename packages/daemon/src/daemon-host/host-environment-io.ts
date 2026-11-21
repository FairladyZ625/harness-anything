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

/** Open a streaming line writer for a caller-specified export artifact path. */
export async function openCallerOutputLineWriter(filePath: string): Promise<{
  readonly writeLine: (line: string) => Promise<void>;
  readonly close: () => Promise<void>;
}> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, "w");
  let closed = false;
  return {
    writeLine: async (line: string) => {
      await handle.write(line, undefined, "utf8");
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await handle.close();
    },
  };
}

/** Write a single caller-specified export artifact file, creating parent directories if needed. */
export async function writeCallerOutputFile(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
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
