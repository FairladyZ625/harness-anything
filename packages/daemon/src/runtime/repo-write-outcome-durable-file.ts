import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import {
  RepoWriteOutcomeCorruptionError,
  RepoWriteOutcomeUnsupportedPlatformError,
  RepoWriteOutcomeValidationError
} from "./repo-write-outcome-errors.ts";

const maximumOutcomeBytes = 2 * 1_024 * 1_024;
export type RepoWriteOutcomeDirectoryFsyncReason =
  "publish" | "observe-existing" | "eexist-observer";
export type RepoWriteOutcomeTargetFsyncReason = "observe-existing" | "eexist-observer";

export interface RepoWriteOutcomeDurabilityTestHooks {
  readonly beforeDirectoryFsync?: (reason: RepoWriteOutcomeDirectoryFsyncReason) => void;
  readonly afterDirectoryFsync?: (reason: RepoWriteOutcomeDirectoryFsyncReason) => void;
  readonly beforePublishLink?: (input: { readonly target: string; readonly text: string }) => void;
  readonly afterTargetFsync?: (input: {
    readonly reason: RepoWriteOutcomeTargetFsyncReason;
    readonly target: string;
  }) => void;
}

export function repoWriteOutcomePublishOnce(
  directory: string,
  target: string,
  text: string,
  hooks?: RepoWriteOutcomeDurabilityTestHooks
): boolean {
  if (Buffer.byteLength(text, "utf8") > maximumOutcomeBytes) {
    throw new RepoWriteOutcomeValidationError(
      `repo-write outcome exceeds the ${maximumOutcomeBytes}-byte durable record limit`
    );
  }
  repoWriteOutcomeEnsurePrivateDirectory(directory);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    fchmodSync(descriptor, 0o600);
    if (process.platform !== "win32" && (fstatSync(descriptor).mode & 0o777) !== 0o600) {
      throw new RepoWriteOutcomeCorruptionError("repo-write temporary outcome must have mode 0600");
    }
    writeFileSync(descriptor, text, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    hooks?.beforePublishLink?.({ target, text });
    try {
      linkSync(temporary, target);
    } catch (error) {
      if (repoWriteOutcomeIsAlreadyExists(error)) {
        repoWriteOutcomeFsyncExisting(target, hooks, "eexist-observer");
        repoWriteOutcomeFsyncDirectory(directory, hooks, "eexist-observer");
        return false;
      }
      throw error;
    }
    repoWriteOutcomeFsyncDirectory(directory, hooks, "publish");
    return true;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

export function repoWriteOutcomeReadPrivateText(file: string): {
  readonly descriptor: number;
  readonly text: string;
} {
  const descriptor = repoWriteOutcomeOpenPrivateRegularFile(file);
  try {
    return { descriptor, text: readFileSync(descriptor, "utf8") };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

export function repoWriteOutcomeFsyncOpened(
  descriptor: number,
  file: string,
  hooks: RepoWriteOutcomeDurabilityTestHooks | undefined,
  reason: RepoWriteOutcomeTargetFsyncReason
): void {
  fsyncSync(descriptor);
  hooks?.afterTargetFsync?.({ reason, target: file });
}

export function repoWriteOutcomeEnsurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const status = lstatSync(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new RepoWriteOutcomeCorruptionError("repo-write outcome root must be a real directory");
  }
  if (process.platform !== "win32") {
    chmodSync(directory, 0o700);
    if ((lstatSync(directory).mode & 0o777) !== 0o700) {
      throw new RepoWriteOutcomeCorruptionError("repo-write outcome root must have mode 0700");
    }
  }
}

export function repoWriteOutcomeFsyncDirectory(
  directory: string,
  hooks: RepoWriteOutcomeDurabilityTestHooks | undefined,
  reason: RepoWriteOutcomeDirectoryFsyncReason
): void {
  if (process.platform === "win32") throw new RepoWriteOutcomeUnsupportedPlatformError();
  hooks?.beforeDirectoryFsync?.(reason);
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  hooks?.afterDirectoryFsync?.(reason);
}

export function repoWriteOutcomeDurablePathExists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function repoWriteOutcomeFsyncExisting(
  file: string,
  hooks: RepoWriteOutcomeDurabilityTestHooks | undefined,
  reason: RepoWriteOutcomeTargetFsyncReason
): void {
  const descriptor = repoWriteOutcomeOpenPrivateRegularFile(file);
  try {
    repoWriteOutcomeFsyncOpened(descriptor, file, hooks, reason);
  } finally {
    closeSync(descriptor);
  }
}

function repoWriteOutcomeOpenPrivateRegularFile(file: string): number {
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const status = fstatSync(descriptor);
  if (!status.isFile()) {
    closeSync(descriptor);
    throw new RepoWriteOutcomeCorruptionError(
      `repo-write outcome is not a regular file: ${path.basename(file)}`
    );
  }
  if (status.size <= 0 || status.size > maximumOutcomeBytes) {
    closeSync(descriptor);
    throw new RepoWriteOutcomeCorruptionError(
      `repo-write outcome has an invalid byte length: ${path.basename(file)}`
    );
  }
  if (process.platform !== "win32" && (status.mode & 0o777) !== 0o600) {
    closeSync(descriptor);
    throw new RepoWriteOutcomeCorruptionError(
      `repo-write outcome must have mode 0600: ${path.basename(file)}`
    );
  }
  return descriptor;
}

function repoWriteOutcomeIsAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
