import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { open, rename, rm, writeFile } from "node:fs/promises";
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
