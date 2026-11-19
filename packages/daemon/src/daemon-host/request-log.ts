import { constants, lstatSync } from "node:fs";
import { mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { consumeKnownError, resolveHarnessLayout } from "@harness-anything/kernel";
import { daemonLogDefaultMaxBytes } from "./lifecycle-log.ts";
import { resolveOwnedLocalDirectory } from "./local-root-paths.ts";
// Classification lives here rather than at the dispatch point: the schema registry names the
// protocol server as a writer, so schema-closure imports it without node_modules and it must stay
// clear of anything that reaches into the kernel.
import { commandClassForAction } from "./protocol/daemon-protocol.contract.ts";
import type { DaemonOperationQueueHead } from "./daemon-operation.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";

// Observability, not accountability. Write receipts are the accountability record and live in the
// git ledger; this file answers "which requests reached this daemon" for every client (CLI, GUI,
// future remote) at the one place they all converge. It is local-only, rolls over, and never
// carries request payloads.
export const DAEMON_REQUEST_LOG_SCHEMA = Object.freeze({ id: "daemon-request-log/v1" });

const requestLogDirName = "requests";
const requestLogFileName = "requests.jsonl";
const defaultKeptDays = 7;
const dayMs = 86_400_000;
type LogLayout = ReturnType<typeof resolveHarnessLayout>;

export interface DaemonWriteTiming {
  /** Wall time spent waiting for the single writer, excluding its execution. */
  readonly queueMs?: number;
  /** Wall time spent executing inside the single writer. */
  readonly writeExecutionMs?: number;
  readonly queueHead?: DaemonOperationQueueHead;
}

export interface DaemonRequestLogEntry extends DaemonWriteTiming {
  readonly method: string;
  readonly repoId: string;
  readonly command: string;
  readonly wait?: boolean;
  readonly connectionId: string;
  readonly auth: DaemonAuthenticationContext;
  readonly executor: { readonly kind: "agent"; readonly id: string } | null;
  readonly ok: boolean;
  readonly outcome: string | null;
  readonly code: string | null;
  readonly opId: string | null;
  readonly detail?: string | null;
  readonly dispatchDelayMs?: number;
  readonly serviceMs?: number;
  readonly durationMs: number;
}

export interface DaemonRequestLogRecord extends DaemonWriteTiming {
  readonly schema: string;
  readonly at: string;
  readonly connectionId: string;
  readonly transport: string;
  readonly ownerUid: number | null;
  readonly principalId: string | null;
  readonly executor: { readonly kind: "agent"; readonly id: string } | null;
  /** The resolved caller identity: the action-declared executor, else the connection's session actor. */
  readonly actor: string | null;
  readonly method: string;
  readonly command: string | null;
  readonly wait: boolean;
  readonly commandClass: string | null;
  readonly repoId: string;
  readonly ok: boolean;
  readonly outcome: string | null;
  readonly code: string | null;
  readonly opId: string | null;
  readonly detail?: string | null;
  readonly dispatchDelayMs: number;
  readonly serviceMs: number;
  readonly durationMs: number;
}

// The one resolution of "which agent made this request": write-family actions declare the executor
// in their payload, and every CLI connection names its session actor in hello (HARNESS_ACTOR,
// "agent:<id>"). Both derive from the same environment, so they never disagree; a person at a
// terminal and the GUI declare neither, which is exactly the agent/person distinction the logs need.
export function agentActorForLog(
  executor: { readonly kind: "agent"; readonly id: string } | null,
  sessionEnvironment: { readonly HARNESS_ACTOR?: string } | undefined,
): string | null {
  if (executor) return executor.id;
  const declared = sessionEnvironment?.HARNESS_ACTOR;
  if (!declared) return null;
  return /^agent:/u.test(declared) ? declared.slice("agent:".length) : declared;
}

export interface DaemonRequestLog {
  readonly record: (entry: DaemonRequestLogEntry) => void;
  readonly settle: () => Promise<void>;
}

export interface DaemonRequestLogOptions {
  // Repo-scoped by construction: a request that binds no repository has no local root to file under.
  readonly resolveRootDir: (repoId: string) => string | undefined;
  readonly maxBytes?: number;
  readonly keptDays?: number;
  readonly now?: () => Date;
  readonly onFailure?: (error: unknown) => void;
  readonly openFile?: typeof open;
}

export function daemonRequestLogPath(rootDir: string): string {
  return path.join(resolveHarnessLayout(rootDir).localRoot, requestLogDirName, requestLogFileName);
}

export function isDaemonRequestLogFileName(name: string): boolean {
  return /^requests\.jsonl(?:\.\d+)?$/u.test(name);
}

export function openDaemonRequestLog(options: DaemonRequestLogOptions): DaemonRequestLog {
  const maxBytes = options.maxBytes ?? daemonLogDefaultMaxBytes;
  const keptDays = options.keptDays ?? defaultKeptDays;
  const now = options.now ?? (() => new Date());
  const openFile = options.openFile ?? open;
  // resolveHarnessLayout walks the filesystem for harness.yaml; hold the resolved path per repo so
  // that cost is paid once instead of on every request.
  const layouts = new Map<string, LogLayout>();
  const sinks = new Map<string, { handle: FileHandle; bytes: number }>();
  let reportedFailure = false;
  let settled = false;
  let chain: Promise<void> = Promise.resolve();

  return {
    record: (entry) => {
      if (settled) return;
      const layout = resolveLogLayout(entry.repoId);
      if (!layout) return;
      chain = chain.then(() => writeRequestLogLine(layout, `${JSON.stringify(buildRecord(entry, now()))}\n`));
    },
    settle: async () => {
      settled = true;
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

  async function writeRequestLogLine(layout: LogLayout, line: string): Promise<void> {
    const logPath = path.join(layout.localRoot, requestLogDirName, requestLogFileName);
    try {
      let sink = sinks.get(logPath);
      if (!sink) sink = await openSink(layout, logPath);
      if (sink.bytes + Buffer.byteLength(line) > maxBytes) {
        // Shift the generation chain and keep writing to the live file. Retention is age-based,
        // so rotation itself never deletes: the old count ceiling dropped the oldest files on
        // every rotation, capping retention at ~1.5 days of canonical traffic and deleting live
        // records within it.
        await closeSink(logPath, sink);
        await rotate(layout);
        sink = await openSink(layout, logPath);
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

  async function openSink(layout: LogLayout, logPath: string): Promise<{ handle: FileHandle; bytes: number }> {
    const directory = ownedLogDirectory(layout, true);
    await /* @gate-identity non-state/environment-io.3dd8b1ca6b76b91c */ mkdir(directory, { recursive: true });
    const target = path.join(ownedLogDirectory(layout), requestLogFileName);
    const file = lstatSync(target, { throwIfNoEntry: false });
    if (file && !file.isFile()) throw new Error(`Request log is not an owned regular file: ${target}`);
    await pruneAgedFiles(layout);
    if (ownedLogDirectory(layout) !== directory) throw new Error(`Request log directory moved: ${directory}`);
    const handle = await openFile(
      target,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    );
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

  // Shift generations without deleting: the live file keeps receiving records and readers follow
  // it as the newest; deletion happens only through age-based pruning below.
  async function rotate(layout: LogLayout): Promise<void> {
    const directory = ownedLogDirectory(layout);
    const generations = (await readdir(directory, { withFileTypes: true }))
      .flatMap((entry) => {
        const { name } = entry;
        const index = Number(name.slice(requestLogFileName.length + 1));
        return Number.isSafeInteger(index) && index > 0 && name === `${requestLogFileName}.${index}` && entry.isFile()
          ? [index]
          : [];
      })
      .sort((left, right) => right - left);
    for (const index of [...generations, 0]) {
      if (ownedLogDirectory(layout) !== directory) return;
      const source = path.join(directory, index === 0 ? requestLogFileName : `${requestLogFileName}.${index}`);
      const target = path.join(directory, `${requestLogFileName}.${index + 1}`);
      if (!lstatSync(source, { throwIfNoEntry: false })?.isFile()) continue;
      const replaced = lstatSync(target, { throwIfNoEntry: false });
      if (replaced) throw new Error(`Request log generation is occupied: ${target}`);
      await renameIfExists(source, target);
    }
  }

  // A file's last write time is its honest age: generations are size-rolled, not day-stamped, so
  // the modification clock — not a file count — decides what falls outside the retention window.
  async function pruneAgedFiles(layout: LogLayout): Promise<void> {
    const directory = ownedLogDirectory(layout),
      cutoff = now().getTime() - keptDays * dayMs;
    for (const name of await readdir(directory)) {
      if (!isDaemonRequestLogFileName(name)) continue;
      if (ownedLogDirectory(layout) !== directory) return;
      const target = path.join(directory, name);
      const info = lstatSync(target, { throwIfNoEntry: false });
      if (info?.isFile() && info.mtimeMs < cutoff)
        await /* @gate-identity non-state/environment-io.69b1169ea4d01ff3 */ rm(target, { force: true });
    }
  }

  function resolveLogLayout(repoId: string): LogLayout | undefined {
    const cached = layouts.get(repoId);
    if (cached) return cached;
    const rootDir = options.resolveRootDir(repoId);
    if (!rootDir) return undefined;
    const layout = resolveHarnessLayout(rootDir);
    layouts.set(repoId, layout);
    return layout;
  }
}

function ownedLogDirectory(layout: LogLayout, allowMissing = false): string {
  const directory = resolveOwnedLocalDirectory(layout, [requestLogDirName], allowMissing);
  if (directory === null)
    throw new Error(`Request log directory is outside its physical boundary: ${layout.localRoot}`);
  return directory;
}

function buildRecord(entry: DaemonRequestLogEntry, at: Date): DaemonRequestLogRecord {
  return {
    schema: DAEMON_REQUEST_LOG_SCHEMA.id,
    at: at.toISOString(),
    connectionId: entry.connectionId,
    transport: entry.auth.transportKind,
    ownerUid: entry.auth.unixSocketOwnerBoundary?.ownerUid ?? null,
    // Record only the independently verified request principal; the device owner is admission data.
    principalId: entry.auth.oidcPrincipal?.personId ?? null,
    executor: entry.executor,
    actor: agentActorForLog(entry.executor, entry.auth.sessionEnvironment),
    method: entry.method,
    command: entry.command,
    wait: entry.wait === true,
    commandClass: commandClassOrNull(entry.command),
    repoId: entry.repoId,
    ok: entry.ok,
    outcome: entry.outcome,
    code: entry.code,
    opId: entry.opId,
    ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    dispatchDelayMs: entry.dispatchDelayMs ?? 0,
    serviceMs: entry.serviceMs ?? entry.durationMs,
    ...(entry.queueMs === undefined ? {} : { queueMs: entry.queueMs }),
    ...(entry.writeExecutionMs === undefined ? {} : { writeExecutionMs: entry.writeExecutionMs }),
    ...(entry.queueHead === undefined ? {} : { queueHead: entry.queueHead }),
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

function renameIfExists(from: string, to: string): Promise<void> {
  return /* @gate-identity non-state/environment-io.b99cb7e864440348 */ rename(from, to).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      consumeKnownError(error);
      return;
    }
    throw error;
  });
}

function defaultFailureReporter(error: unknown): void {
  process.stderr.write(
    `harness daemon: request log disabled after write failure: ${error instanceof Error ? error.message : String(error)}\n`,
  );
}
