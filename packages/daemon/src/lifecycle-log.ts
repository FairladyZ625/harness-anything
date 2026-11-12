import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { consumeKnownError } from "@harness-anything/kernel/internal/error-consumption";
import type { DaemonEntry } from "./build-identity.ts";
import { readLatestLineInTail } from "./dispatch-stream-tail.ts";

export const DAEMON_LIFECYCLE_LOG_SCHEMA = Object.freeze({ id: "daemon-lifecycle/v1" });
// One definition of the daemon's file-log rotation defaults (lifecycle and request sinks share
// the shape); request-log imports these instead of re-encoding the numbers, so the sinks cannot
// drift apart.
export const daemonLogDefaultMaxBytes = 4 * 1024 * 1024;
export const daemonLogDefaultKeptFiles = 4;

export type DaemonLifecycleEvent =
  | "diagnostics"
  | "process_start"
  | "process_stopping"
  | "socket_bound"
  | "process_exit"
  | "repo_attach_started"
  | "repo_attach_completed"
  | "repo_attach_failed"
  | "replica_sync_failed"
  | "replica_confirm_failed"
  | "repo_attach_timed_out"
  | "repo_attach_discarded"
  | "repo_registry_pruned"
  | "attachments_settled"
  | "runtime_recovery_failed"
  | "runtime_observation_failed"
  | "runtime_spawn"
  | "runtime_exit"
  | "materializer_effect_denied"
  | "materializer_candidate_blocked"
  | "materializer_inventory_failed"
  | "identity_ready"
  | "rbac_resume_failed"
  | "rbac_child_exited"
  | "rbac_restart_scheduled"
  | "rbac_restart"
  | "fleet_center_restore_failed";
export interface DaemonLifecycleEntry {
  readonly event: DaemonLifecycleEvent;
  readonly repoId?: string;
  readonly rootDir?: string;
  readonly durationMs?: number;
  readonly revision?: number;
  readonly attachIndex?: number;
  readonly attachTotal?: number;
  readonly endpoint?: string;
  readonly outcome?: string;
  /** Boolean result of a one-shot lifecycle operation (e.g. a supervised restart). */
  readonly ok?: boolean;
  readonly error?: string;
  /** The failing operation's own error code, so a repeated failure is classifiable without parsing text. */
  readonly code?: string;
  readonly registeredAt?: string;
  readonly attached?: number;
  readonly unavailable?: number;
  readonly pruned?: number;
  readonly runtimeSessionId?: string;
  readonly dispatchId?: string;
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  /** The daemon-owned managed service an event is about. */
  readonly service?: string;
  readonly delayMs?: number;
  readonly attempt?: number;
  readonly reason?: string | null;
  readonly commit?: string | null;
  readonly entry?: DaemonEntry;
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

// Two sinks, two files, one record shape each. The structured lifecycle JSONL and the
// daemon child's raw stdout/stderr used to interleave line by line into a single inode,
// which left the JSONL unreadable by every JSONL reader in the system.
export function daemonLifecycleLogPath(userRoot: string, daemonId: string): string {
  return path.join(userRoot, "logs", `daemon-${safeLifecycleRuntimeId(daemonId)}-lifecycle.jsonl`);
}

/** Raw stdout/stderr of the spawned daemon process; free-form text, never parsed as JSONL. */
export function daemonStdioLogPath(userRoot: string, daemonId: string): string {
  return path.join(userRoot, "logs", `daemon-${safeLifecycleRuntimeId(daemonId)}.log`);
}

/** Raw stdout/stderr of a `ha gui`-launched desktop shell; same sink convention as the daemon's. */
export function guiStdioLogPath(userRoot: string, daemonId: string): string {
  return path.join(userRoot, "logs", `gui-${safeLifecycleRuntimeId(daemonId)}.log`);
}

export function openDaemonLifecycleLog(input: {
  readonly userRoot: string;
  readonly daemonId: string;
  readonly logKind?: "diagnostics";
  readonly maxBytes?: number;
  readonly keptFiles?: number;
  readonly now?: () => Date;
  readonly pid?: number;
  readonly onFailure?: (error: unknown) => void;
}): DaemonLifecycleLog {
  const logPath = daemonLifecycleLogPath(input.userRoot, input.daemonId).replace(
      /-lifecycle\.jsonl$/u,
      `-${input.logKind ?? "lifecycle"}.jsonl`,
    ),
    maxBytes = input.maxBytes ?? daemonLogDefaultMaxBytes,
    keptFiles = input.keptFiles ?? daemonLogDefaultKeptFiles,
    now = input.now ?? (() => new Date()),
    pid = input.pid ?? process.pid;
  let preparedDirectory = false,
    reportedFailure = false;
  return {
    record: (entry) => {
      try {
        if (!preparedDirectory) {
          /* @gate-identity non-state/environment-io.ec7a202fd7b6fd10 */ mkdirSync(path.dirname(logPath), {
            recursive: true,
          });
          preparedDirectory = true;
        }
        // One recorder serves the daemon's whole life, so the size cap is rechecked before every
        // append: rotateLifecycleLog early-returns on a single statSync when the file is under it.
        rotateLifecycleLog(logPath, maxBytes, keptFiles);
        /* @gate-identity non-state/environment-io.df81aef7aa74b913 */ appendFileSync(
          logPath,
          `${JSON.stringify({ schema: input.logKind ? "daemon-diagnostics/v1" : DAEMON_LIFECYCLE_LOG_SCHEMA.id, at: now().toISOString(), daemonId: input.daemonId, pid, ...entry } satisfies DaemonLifecycleRecord)}\n`,
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
// Since the stdio file is no longer the lifecycle file, the recorder's own rotation can
// no longer rename the inode out from under the child either: the two sinks rotate
// independently, so the invariant now holds without depending on write ordering.
export function openDaemonOutputFd(
  logPath: string,
  maxBytes = daemonLogDefaultMaxBytes,
  keptFiles = daemonLogDefaultKeptFiles,
): number {
  /* @gate-identity non-state/environment-io.d0c312cacca07778 */ mkdirSync(path.dirname(logPath), { recursive: true });
  rotateLifecycleLog(logPath, maxBytes, keptFiles);
  return /* @gate-identity non-state/environment-io.435edbd8df19f65d */ openSync(logPath, "a", 0o600);
}

export function closeDaemonOutputFd(fd: number): void {
  try {
    /* @gate-identity non-state/environment-io.3d928f21650aab9d */ closeSync(fd);
  } catch (error) {
    consumeKnownError(error);
  }
}

export function readDaemonLifecycleRecords(
  userRoot: string,
  daemonId: string,
  scope: "retained" | "current-generation" = "retained",
): readonly DaemonLifecycleRecord[] {
  const directory = path.dirname(daemonLifecycleLogPath(userRoot, daemonId)),
    base = path.basename(daemonLifecycleLogPath(userRoot, daemonId));
  let files: string[];
  try {
    files = lifecycleLogFiles(directory, base);
  } catch (error) {
    consumeKnownError(error);
    return [];
  }
  const records: DaemonLifecycleRecord[] = [];
  if (scope === "current-generation") {
    // The readiness probe runs every 50 ms while a CLI waits, so this scan starts at the end of the
    // newest retained file and stops at the generation's process_start: the work is bounded by what
    // this generation wrote, not by the whole retained history. A generation that rotated while it
    // was still starting keeps its process_start in the newest retained file, so the scan crosses
    // that one boundary and no further than it must.
    for (let index = files.length - 1; index >= 0; index -= 1) {
      let descriptor: number;
      try {
        descriptor = /* @gate-identity non-state/environment-io.2534a7ea79e2c8d2 */ openSync(
          path.join(directory, files[index]!),
          "r",
        );
      } catch (error) {
        if (!isMissing(error)) throw error;
        consumeKnownError(error);
        continue;
      }
      try {
        const size = fstatSync(descriptor).size,
          found = readLatestLineInTail(descriptor, size, size, (line) => {
            let record: DaemonLifecycleRecord | null = null;
            if (line.startsWith("{")) {
              try {
                const value = JSON.parse(line) as DaemonLifecycleRecord;
                if (value.schema === DAEMON_LIFECYCLE_LOG_SCHEMA.id) record = value;
              } catch (error) {
                consumeKnownError(error);
              }
            }
            if (record === null) return null;
            records.push(record);
            return record.event === "process_start" ? record : null;
          });
        if (found) return records.reverse();
      } finally {
        /* @gate-identity non-state/environment-io.5a87f3c7e94203a3 */ closeSync(descriptor);
      }
    }
    return [];
  }
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

/** The newest generation's records only; the retained history is not parsed. */
export function readDaemonLifecycleGeneration(userRoot: string, daemonId: string): readonly DaemonLifecycleRecord[] {
  return readDaemonLifecycleRecords(userRoot, daemonId, "current-generation");
}

/** Rotation keeps the oldest generation first: `.N` … `.1`, then the live file. */
function lifecycleLogFiles(directory: string, base: string): string[] {
  return readdirSync(directory)
    .filter((file) => file === base || file.startsWith(`${base}.`))
    .sort((left, right) => generation(right) - generation(left));
}

function rotateLifecycleLog(logPath: string, maxBytes: number, keptFiles: number): void {
  if (logFileSize(logPath) < maxBytes) return;
  if (keptFiles < 1) {
    /* @gate-identity non-state/environment-io.704983ddbd864c1d */ rmSync(logPath, { force: true });
    return;
  }
  /* @gate-identity non-state/environment-io.72b8d8e75f7f721b */ rmSync(`${logPath}.${keptFiles}`, { force: true });
  for (let index = keptFiles - 1; index >= 1; index -= 1)
    if (logFileExists(`${logPath}.${index}`))
      /* @gate-identity non-state/environment-io.801d4a0fe4d0d9b8 */ renameSync(
        `${logPath}.${index}`,
        `${logPath}.${index + 1}`,
      );
  /* @gate-identity non-state/environment-io.c079f11d542d95e6 */ renameSync(logPath, `${logPath}.1`);
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
