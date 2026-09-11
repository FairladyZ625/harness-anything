import { mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
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
  readonly dispatchDelayMs?: number;
  readonly serviceMs?: number;
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
  readonly dispatchDelayMs: number;
  readonly serviceMs: number;
  readonly durationMs: number;
}

export interface DaemonRequestLog {
  readonly record: (entry: DaemonRequestLogEntry) => void;
  readonly settle: () => Promise<void>;
}

export interface DaemonRequestLogOptions {
  // Repo-scoped by construction: a request that binds no repository has no local root to file under.
  readonly resolveRootDir: (repoId: string) => string | undefined;
  readonly maxBytes?: number;
  readonly keptFiles?: number;
  readonly now?: () => Date;
  readonly onFailure?: (error: unknown) => void;
  readonly openFile?: typeof open;
}

export function daemonRequestLogPath(rootDir: string): string {
  return path.join(resolveHarnessLayout(rootDir).localRoot, requestLogDirName, requestLogFileName);
}

export function openDaemonRequestLog(options: DaemonRequestLogOptions): DaemonRequestLog {
  const maxBytes = options.maxBytes ?? defaultMaxBytes;
  const keptFiles = options.keptFiles ?? defaultKeptFiles;
  const now = options.now ?? (() => new Date());
  const openFile = options.openFile ?? open;
  // resolveHarnessLayout walks the filesystem for harness.yaml; hold the resolved path per repo so
  // that cost is paid once instead of on every request.
  const logPaths = new Map<string, string>();
  const sinks = new Map<string, { handle: FileHandle; bytes: number }>();
  let reportedFailure = false;
  let chain: Promise<void> = Promise.resolve();

  return {
    record: (entry) => {
      const logPath = resolveLogPath(entry.repoId);
      if (!logPath) return;
      chain = chain.then(() => writeRequestLogLine(logPath, `${JSON.stringify(buildRecord(entry, now()))}\n`));
    },
    settle: async () => {
      let tail: Promise<void>;
      do {
        tail = chain;
        await tail;
      } while (tail !== chain);
      chain = chain.then(async () => {
        for (const [logPath, sink] of sinks) {
          await closeSink(logPath, sink);
        }
      });
      await chain;
    },
  };

  async function writeRequestLogLine(logPath: string, line: string): Promise<void> {
    try {
      let sink = sinks.get(logPath);
      if (!sink) sink = await openSink(logPath);
      if (sink.bytes + Buffer.byteLength(line) > maxBytes) {
        await closeSink(logPath, sink);
        await rotate(logPath, keptFiles);
        sink = await openSink(logPath);
      }
      sink.bytes += (await sink.handle.write(line, null, "utf8")).bytesWritten;
    } catch (error) {
      consumeKnownError(error);
      const sink = sinks.get(logPath);
      if (sink) await closeSink(logPath, sink);
      if (!reportedFailure) {
        reportedFailure = true;
        (options.onFailure ?? defaultFailureReporter)(error);
      }
    }
  }

  async function openSink(logPath: string): Promise<{ handle: FileHandle; bytes: number }> {
    await mkdir(path.dirname(logPath), { recursive: true });
    const handle = await openFile(logPath, "a");
    const sink = { handle, bytes: (await handle.stat()).size };
    sinks.set(logPath, sink);
    return sink;
  }

  async function closeSink(logPath: string, sink: { handle: FileHandle; bytes: number }): Promise<void> {
    if (sinks.get(logPath) === sink) sinks.delete(logPath);
    try {
      await sink.handle.close();
    } catch (error) {
      consumeKnownError(error);
    }
  }

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
    dispatchDelayMs: entry.dispatchDelayMs ?? 0,
    serviceMs: entry.serviceMs ?? entry.durationMs,
    durationMs: entry.durationMs,
  };
}

// A transport method that resolves to no action kind (protocol.hello and friends) has no command
// class; the record still carries the method it was reached by.
function commandClassOrNull(command: string): string | null {
  try {
    return commandClassForAction(command);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

async function rotate(logPath: string, keptFiles: number): Promise<void> {
  if (keptFiles < 1) {
    await rm(logPath, { force: true });
    return;
  }
  await rm(`${logPath}.${keptFiles}`, { force: true });
  for (let index = keptFiles - 1; index >= 1; index -= 1) {
    try {
      await rename(`${logPath}.${index}`, `${logPath}.${index + 1}`);
    } catch (error) {
      consumeKnownError(error);
      if (!isMissingFile(error)) throw error;
    }
  }
  await rename(logPath, `${logPath}.1`);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function defaultFailureReporter(error: unknown): void {
  process.stderr.write(
    `harness daemon: request log disabled after write failure: ${error instanceof Error ? error.message : String(error)}\n`,
  );
}
