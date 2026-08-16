import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { consumeKnownError, resolveHarnessLayout } from "../../kernel/src/index.ts";
// Classification lives here rather than at the dispatch point: the schema registry names the
// protocol server as a writer, so schema-closure imports it without node_modules and it must stay
// clear of anything that reaches into the kernel.
import { commandClassForAction } from "./protocol/daemon-protocol.contract.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";

// Observability, not accountability. Write receipts are the accountability record and live in the
// git ledger; this file answers "which requests reached this daemon" for every client (CLI, GUI,
// future remote) at the one place they all converge. It is local-only, rolls over, and never
// carries request payloads.
export const DAEMON_REQUEST_LOG_SCHEMA = Object.freeze({ id: "daemon-request-log/v1" });

const requestLogDirName = "requests";
const requestLogFileName = "requests.jsonl";
const defaultMaxBytes = 4 * 1024 * 1024;
const defaultKeptFiles = 4;

export interface DaemonRequestLogEntry {
  readonly method: string;
  readonly repoId: string;
  readonly command: string;
  readonly connectionId: string;
  readonly auth: DaemonAuthenticationContext;
  readonly executor: { readonly kind: "agent"; readonly id: string } | null;
  readonly ok: boolean;
  readonly outcome: string | null;
  readonly code: string | null;
  readonly opId: string | null;
  readonly durationMs: number;
}

export interface DaemonRequestLogRecord {
  readonly schema: string;
  readonly at: string;
  readonly connectionId: string;
  readonly transport: string;
  readonly ownerUid: number | null;
  readonly principalId: string | null;
  readonly executor: { readonly kind: "agent"; readonly id: string } | null;
  readonly method: string;
  readonly command: string | null;
  readonly commandClass: string | null;
  readonly repoId: string;
  readonly ok: boolean;
  readonly outcome: string | null;
  readonly code: string | null;
  readonly opId: string | null;
  readonly durationMs: number;
}

export interface DaemonRequestLog {
  readonly record: (entry: DaemonRequestLogEntry) => void;
}

export interface DaemonRequestLogOptions {
  // Repo-scoped by construction: a request that binds no repository has no local root to file under.
  readonly resolveRootDir: (repoId: string) => string | undefined;
  readonly maxBytes?: number;
  readonly keptFiles?: number;
  readonly now?: () => Date;
  readonly onFailure?: (error: unknown) => void;
}

export function daemonRequestLogPath(rootDir: string): string {
  return path.join(resolveHarnessLayout(rootDir).localRoot, requestLogDirName, requestLogFileName);
}

export function openDaemonRequestLog(options: DaemonRequestLogOptions): DaemonRequestLog {
  const maxBytes = options.maxBytes ?? defaultMaxBytes;
  const keptFiles = options.keptFiles ?? defaultKeptFiles;
  const now = options.now ?? (() => new Date());
  // resolveHarnessLayout walks the filesystem for harness.yaml; hold the resolved path per repo so
  // that cost is paid once instead of on every request.
  const logPaths = new Map<string, string>();
  let reportedFailure = false;

  return {
    record: (entry) => {
      try {
        const logPath = resolveLogPath(entry.repoId);
        if (!logPath) return;
        mkdirSync(path.dirname(logPath), { recursive: true });
        rotate(logPath, maxBytes, keptFiles);
        appendFileSync(logPath, `${JSON.stringify(buildRecord(entry, now()))}\n`, "utf8");
      } catch (error) {
        // An observability sink must never fail the request it observes, but a sink that fails
        // forever in silence is worse than no sink: report the first failure, then stay quiet.
        consumeKnownError(error);
        if (reportedFailure) return;
        reportedFailure = true;
        (options.onFailure ?? defaultFailureReporter)(error);
      }
    }
  };

  function resolveLogPath(repoId: string): string | undefined {
    const cached = logPaths.get(repoId);
    if (cached) return cached;
    const rootDir = options.resolveRootDir(repoId);
    if (!rootDir) return undefined;
    const logPath = daemonRequestLogPath(rootDir);
    logPaths.set(repoId, logPath);
    return logPath;
  }
}

function buildRecord(entry: DaemonRequestLogEntry, at: Date): DaemonRequestLogRecord {
  return {
    schema: DAEMON_REQUEST_LOG_SCHEMA.id,
    at: at.toISOString(),
    connectionId: entry.connectionId,
    transport: entry.auth.transportKind,
    ownerUid: entry.auth.unixSocketOwnerBoundary?.ownerUid ?? null,
    // The daemon resolves the principal inside the write binding, which the protocol layer cannot
    // observe. Fleet assignment ingress carries it on the auth context, so record it where it is
    // genuinely known and leave it null rather than guessing.
    principalId: entry.auth.assignmentBinding?.actor.principal.personId ?? null,
    executor: entry.executor,
    method: entry.method,
    command: entry.command,
    commandClass: commandClassOrNull(entry.command),
    repoId: entry.repoId,
    ok: entry.ok,
    outcome: entry.outcome,
    code: entry.code,
    opId: entry.opId,
    durationMs: entry.durationMs
  };
}

// A transport method that resolves to no action kind (protocol.hello and friends) has no command
// class; the record still carries the method it was reached by.
function commandClassOrNull(command: string): string | null {
  try { return commandClassForAction(command); } catch (error) { consumeKnownError(error); return null; }
}

function rotate(logPath: string, maxBytes: number, keptFiles: number): void {
  if (fileSize(logPath) < maxBytes) return;
  if (keptFiles < 1) {
    rmSync(logPath, { force: true });
    return;
  }
  rmSync(`${logPath}.${keptFiles}`, { force: true });
  for (let index = keptFiles - 1; index >= 1; index -= 1) {
    if (fileExists(`${logPath}.${index}`)) renameSync(`${logPath}.${index}`, `${logPath}.${index + 1}`);
  }
  renameSync(logPath, `${logPath}.1`);
}

function fileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch (error) {
    if (isMissingFile(error)) return 0;
    throw error;
  }
}

function fileExists(filePath: string): boolean {
  try {
    statSync(filePath);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function defaultFailureReporter(error: unknown): void {
  process.stderr.write(`harness daemon: request log disabled after write failure: ${error instanceof Error ? error.message : String(error)}\n`);
}
