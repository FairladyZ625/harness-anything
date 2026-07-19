import {
  decodeDaemonLogEntry,
  type DaemonLogEntryV1,
  type DaemonLogService
} from "../../../application/src/index.ts";
import { makeDaemonLogFileStore } from "./daemon-log-file-store.ts";

const lifecycleEventSchema = "daemon-lifecycle-event/v1" as const;

interface DaemonLifecycleRunningEvent {
  readonly schema: typeof lifecycleEventSchema;
  readonly phase: "running";
  readonly instanceId: string;
  readonly pid: number;
  readonly startedAt: string;
}

interface DaemonLifecycleTerminalEvent {
  readonly schema: typeof lifecycleEventSchema;
  readonly phase: "terminated";
  readonly instanceId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly observedAt: string;
  readonly reason: string;
  readonly clean: boolean;
}

type DaemonLifecycleEvent = DaemonLifecycleRunningEvent | DaemonLifecycleTerminalEvent;

export interface DaemonLifecycleProjection {
  readonly state: "never-started" | "previously-started-untracked" | "running" | "running-unreachable" | "running-untracked" | "cleanly-terminated" | "exited-unexpectedly";
  readonly previouslyStarted: boolean;
  readonly reason: string;
  readonly pid?: number;
  readonly startedAt?: string;
  readonly terminalAt?: string;
}

export interface DaemonLifecycleRepoContext {
  readonly repoId: string;
  readonly canonicalRoot: string;
}

export async function recordDaemonStarted(input: {
  readonly userRoot: string;
  readonly logService: DaemonLogService;
  readonly repo: DaemonLifecycleRepoContext;
  readonly instanceId: string;
  readonly pid: number;
  readonly startedAt: string;
}): Promise<void> {
  const previous = (await readLifecycleHistory(input.userRoot)).latest;
  if (previous?.phase === "running" && !daemonLifecycleProcessIsAlive(previous.pid)) {
    await recordInferredExit({ logService: input.logService, repo: input.repo, state: previous });
  }
  const event: DaemonLifecycleRunningEvent = {
    schema: lifecycleEventSchema,
    phase: "running",
    instanceId: input.instanceId,
    pid: input.pid,
    startedAt: input.startedAt
  };
  await input.logService.append({
    level: "info",
    source: "daemon",
    component: "daemon.lifecycle",
    event: "daemon.lifecycle.started",
    message: JSON.stringify(event)
  }, { repo: input.repo });
}

export async function recordDaemonTerminated(input: {
  readonly userRoot: string;
  readonly logService: DaemonLogService;
  readonly repo: DaemonLifecycleRepoContext;
  readonly instanceId: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly reason: string;
  readonly clean: boolean;
  readonly message?: string;
}): Promise<void> {
  const event: DaemonLifecycleTerminalEvent = {
    schema: lifecycleEventSchema,
    phase: "terminated",
    instanceId: input.instanceId,
    pid: input.pid,
    startedAt: input.startedAt,
    observedAt: new Date().toISOString(),
    reason: input.reason,
    clean: input.clean
  };
  await input.logService.append({
    level: input.clean ? "info" : "fatal",
    source: "daemon",
    component: "daemon.lifecycle",
    event: "daemon.lifecycle.terminated",
    message: JSON.stringify(event),
    ...(!input.clean ? { errorCode: "DAEMON_UNEXPECTED_EXIT", hint: input.message ?? null } : {})
  }, { repo: input.repo });
}

export async function observeDaemonLifecycle(input: {
  readonly userRoot: string;
  readonly repo: DaemonLifecycleRepoContext;
  readonly reachable: boolean;
  readonly logService: DaemonLogService;
}): Promise<DaemonLifecycleProjection> {
  const history = await readLifecycleHistory(input.userRoot);
  const state = history.latest;
  if (!state) {
    if (input.reachable) return { state: "running-untracked", previouslyStarted: true, reason: "legacy-no-lifecycle-record" };
    return history.hasOperationalHistory
      ? { state: "previously-started-untracked", previouslyStarted: true, reason: "legacy-operational-history-without-lifecycle" }
      : { state: "never-started", previouslyStarted: false, reason: "no-lifecycle-record" };
  }
  if (state.phase === "terminated") return terminalProjection(state);
  if (input.reachable) return runningProjection(state, "running", "reachable");
  if (daemonLifecycleProcessIsAlive(state.pid)) {
    return runningProjection(state, "running-unreachable", "process-alive-endpoint-unreachable");
  }

  const terminal = await recordInferredExit({ logService: input.logService, repo: input.repo, state });
  return terminalProjection(terminal);
}

async function recordInferredExit(input: {
  readonly logService: DaemonLogService;
  readonly repo: DaemonLifecycleRepoContext;
  readonly state: DaemonLifecycleRunningEvent;
}): Promise<DaemonLifecycleTerminalEvent> {
  const terminal: DaemonLifecycleTerminalEvent = {
    ...input.state,
    phase: "terminated",
    observedAt: new Date().toISOString(),
    reason: "process-disappeared",
    clean: false
  };
  await input.logService.append({
    level: "fatal",
    source: "cli",
    component: "daemon.lifecycle",
    event: "daemon.lifecycle.exit-inferred",
    message: JSON.stringify(terminal),
    errorCode: "DAEMON_PROCESS_DISAPPEARED",
    hint: `Daemon pid=${input.state.pid} disappeared without recording a terminal reason.`
  }, { repo: input.repo });
  return terminal;
}

async function readLifecycleHistory(userRoot: string): Promise<{
  readonly latest: DaemonLifecycleEvent | undefined;
  readonly hasOperationalHistory: boolean;
}> {
  const stored = await makeDaemonLogFileStore({ userRoot }).read();
  const entries = stored.records.flatMap((record) => decodeDaemonOperationalLogEntry(record));
  return {
    latest: entries
      .flatMap((entry) => decodeLifecycleLogEntry(entry))
    .sort((left, right) => right.entry.sequence - left.entry.sequence)
      .at(0)?.event,
    hasOperationalHistory: entries.length > 0
  };
}

function decodeDaemonOperationalLogEntry(record: unknown): ReadonlyArray<DaemonLogEntryV1> {
  try {
    return [decodeDaemonLogEntry(record)];
  } catch {
    return [];
  }
}

function decodeLifecycleLogEntry(entry: DaemonLogEntryV1): ReadonlyArray<{
  readonly entry: DaemonLogEntryV1;
  readonly event: DaemonLifecycleEvent;
}> {
  if (entry.component !== "daemon.lifecycle") return [];
  try {
    const event = JSON.parse(entry.message) as unknown;
    return isDaemonLifecycleEvent(event) ? [{ entry, event }] : [];
  } catch {
    return [];
  }
}

function isDaemonLifecycleEvent(value: unknown): value is DaemonLifecycleEvent {
  if (!isDaemonLifecycleEventRecord(value) || value.schema !== lifecycleEventSchema) return false;
  if (typeof value.instanceId !== "string" || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.startedAt !== "string") return false;
  if (value.phase === "running") return true;
  return value.phase === "terminated"
    && typeof value.observedAt === "string"
    && typeof value.reason === "string"
    && typeof value.clean === "boolean";
}

function terminalProjection(state: DaemonLifecycleTerminalEvent): DaemonLifecycleProjection {
  return {
    state: state.clean ? "cleanly-terminated" : "exited-unexpectedly",
    previouslyStarted: true,
    reason: state.reason,
    pid: state.pid,
    startedAt: state.startedAt,
    terminalAt: state.observedAt
  };
}

function runningProjection(
  state: DaemonLifecycleRunningEvent,
  lifecycleState: "running" | "running-unreachable",
  reason: string
): DaemonLifecycleProjection {
  return {
    state: lifecycleState,
    previouslyStarted: true,
    reason,
    pid: state.pid,
    startedAt: state.startedAt
  };
}

function daemonLifecycleProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !daemonLifecycleErrorHasCode(error, "ESRCH");
  }
}

function isDaemonLifecycleEventRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function daemonLifecycleErrorHasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
