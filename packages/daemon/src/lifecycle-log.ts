import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { consumeKnownError } from "../../kernel/src/index.ts";

export const DAEMON_LIFECYCLE_LOG_SCHEMA = Object.freeze({ id: "daemon-lifecycle/v1" });
const defaultMaxBytes = 4 * 1024 * 1024;
const defaultKeptFiles = 4;

export type DaemonLifecycleEvent =
  | "process_start"
  | "socket_bound"
  | "process_exit"
  | "repo_attach_started"
  | "repo_attach_completed"
  | "repo_attach_failed"
  | "repo_attach_timed_out"
  | "repo_registry_pruned"
  | "attachments_settled"
  | "runtime_spawn"
  | "runtime_exit";
export interface DaemonLifecycleEntry {
  readonly event: DaemonLifecycleEvent;
  readonly repoId?: string;
  readonly rootDir?: string;
  readonly durationMs?: number;
  readonly attachIndex?: number;
  readonly attachTotal?: number;
  readonly endpoint?: string;
  readonly outcome?: string;
  readonly error?: string;
  readonly registeredAt?: string;
  readonly attached?: number;
  readonly unavailable?: number;
  readonly pruned?: number;
  readonly runtimeSessionId?: string;
  readonly dispatchId?: string;
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly reason?: string | null;
  readonly commit?: string | null;
  readonly loadedBuildId?: string | null;
  readonly diskBuildId?: string | null;
  readonly drifted?: boolean;
}
export interface DaemonLifecycleRecord extends DaemonLifecycleEntry {
  readonly schema: string;
  readonly at: string;
  readonly daemonId: string;
  readonly pid: number;
}
export interface DaemonLifecycleLog {
  readonly record: (entry: DaemonLifecycleEntry) => void;
}
export type DaemonLifecycleRecorder = DaemonLifecycleLog["record"];

export function daemonLifecycleLogPath(userRoot: string, daemonId: string): string {
  return path.join(userRoot, "logs", `daemon-${safeLifecycleRuntimeId(daemonId)}.log`);
}

export function openDaemonLifecycleLog(input: {
  readonly userRoot: string;
  readonly daemonId: string;
  readonly maxBytes?: number;
  readonly keptFiles?: number;
  readonly now?: () => Date;
  readonly pid?: number;
  readonly onFailure?: (error: unknown) => void;
}): DaemonLifecycleLog {
  const logPath = daemonLifecycleLogPath(input.userRoot, input.daemonId),
    maxBytes = input.maxBytes ?? defaultMaxBytes,
    keptFiles = input.keptFiles ?? defaultKeptFiles,
    now = input.now ?? (() => new Date()),
    pid = input.pid ?? process.pid;
  let prepared = false,
    reportedFailure = false;
  return {
    record: (entry) => {
      try {
        if (!prepared) {
          mkdirSync(path.dirname(logPath), { recursive: true });
          rotateLifecycleLog(logPath, maxBytes, keptFiles);
          prepared = true;
        }
        appendFileSync(
          logPath,
          `${JSON.stringify({ schema: DAEMON_LIFECYCLE_LOG_SCHEMA.id, at: now().toISOString(), daemonId: input.daemonId, pid, ...entry } satisfies DaemonLifecycleRecord)}\n`,
          "utf8",
        );
      } catch (error) {
        consumeKnownError(error);
        if (reportedFailure) return;
        reportedFailure = true;
        (input.onFailure ?? defaultLifecycleFailureReporter)(error);
      }
    },
  };
}

// The launcher rotates before opening the fd. The child then owns that inode for its
// whole lifetime, so a mid-run rename can never strand fatal stderr in an old file.
export function openDaemonOutputFd(logPath: string, maxBytes = defaultMaxBytes, keptFiles = defaultKeptFiles): number {
  mkdirSync(path.dirname(logPath), { recursive: true });
  rotateLifecycleLog(logPath, maxBytes, keptFiles);
  return openSync(logPath, "a", 0o600);
}

export function closeDaemonOutputFd(fd: number): void {
  try {
    closeSync(fd);
  } catch (error) {
    consumeKnownError(error);
  }
}

export function readDaemonLifecycleRecords(userRoot: string, daemonId: string): readonly DaemonLifecycleRecord[] {
  const directory = path.dirname(daemonLifecycleLogPath(userRoot, daemonId)),
    base = path.basename(daemonLifecycleLogPath(userRoot, daemonId));
  let files: string[];
  try {
    files = readdirSync(directory)
      .filter((file) => file === base || file.startsWith(`${base}.`))
      .sort((left, right) => generation(right) - generation(left));
  } catch (error) {
    consumeKnownError(error);
    return [];
  }
  const records: DaemonLifecycleRecord[] = [];
  for (const file of files)
    for (const line of readFileSync(path.join(directory, file), "utf8").split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const value = JSON.parse(line) as DaemonLifecycleRecord;
        if (value.schema === DAEMON_LIFECYCLE_LOG_SCHEMA.id) records.push(value);
      } catch (error) {
        consumeKnownError(error);
      }
    }
  return records;
}

function rotateLifecycleLog(logPath: string, maxBytes: number, keptFiles: number): void {
  if (logFileSize(logPath) < maxBytes) return;
  if (keptFiles < 1) {
    rmSync(logPath, { force: true });
    return;
  }
  rmSync(`${logPath}.${keptFiles}`, { force: true });
  for (let index = keptFiles - 1; index >= 1; index -= 1)
    if (logFileExists(`${logPath}.${index}`)) renameSync(`${logPath}.${index}`, `${logPath}.${index + 1}`);
  renameSync(logPath, `${logPath}.1`);
}
function logFileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
}
function logFileExists(filePath: string): boolean {
  try {
    statSync(filePath);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function generation(file: string): number {
  const suffix = Number(file.slice(file.lastIndexOf(".") + 1));
  return Number.isInteger(suffix) ? suffix : 0;
}
function safeLifecycleRuntimeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, "-");
}
function defaultLifecycleFailureReporter(error: unknown): void {
  process.stderr.write(
    `harness daemon: lifecycle log disabled after write failure: ${error instanceof Error ? error.message : String(error)}\n`,
  );
}
