import path from "node:path";
import {
  acquireDaemonAutostartFlight,
  daemonProcessAlive,
  daemonSocketProbe,
  readDaemonSingletonLockPid,
} from "../daemon-singleton.ts";
import { daemonLifecycleLogPath, readDaemonLifecycleRecords } from "../lifecycle-log.ts";
import { startDetachedProcessChecked } from "../process-port.ts";
export interface DaemonLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}
export const autostartFailureCodes = [
  "daemon_start_runtime_forbidden",
  "daemon_spawn_not_found",
  "daemon_spawn_permission",
  "daemon_start_failed",
  "daemon_bind_timeout",
  "daemon_starting",
] as const;
export type DaemonAutostartFailureCode = (typeof autostartFailureCodes)[number];
export interface DaemonAutostartResult {
  readonly ok: boolean;
  readonly code?: DaemonAutostartFailureCode;
  readonly hint: string;
  readonly attempts: number;
}
export interface DaemonStartProgress {
  readonly fingerprint: string;
  readonly message: string;
}
export class DaemonAutostartError extends Error {
  readonly code: DaemonAutostartFailureCode;
  readonly attempts: number;
  constructor(result: DaemonAutostartResult) {
    super(result.hint);
    this.name = "DaemonAutostartError";
    this.code = result.code ?? "daemon_start_failed";
    this.attempts = result.attempts;
  }
}
export function isDaemonUnreachable(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string") return code === "ECONNREFUSED" || code === "ENOENT" || code === "ETIMEDOUT";
  }
  return error instanceof Error && error.message === "daemon_unavailable";
}
export async function runtimeDaemonStartRefusal(
  socketPath: string,
  env: NodeJS.ProcessEnv = process.env,
  probe: (socketPath: string) => Promise<boolean> = daemonSocketProbe,
): Promise<{ readonly code: "daemon_start_runtime_forbidden"; readonly hint: string } | null> {
  if (env.HARNESS_ACTOR?.startsWith("agent:runtime-session:") !== true || (await probe(socketPath))) return null;
  return {
    code: "daemon_start_runtime_forbidden",
    hint: [
      "A task-bound runtime cannot start the shared daemon because its HOME and PATH belong to the runtime instance.",
      "Start the daemon from an operator shell with `ha daemon start --service`, then retry the worker command.",
    ].join(" "),
  };
}
export async function ensureLocalDaemonRunning(input: {
  readonly socketPath: string;
  readonly launch: () => DaemonLaunchSpec;
  readonly readyTimeoutMs?: number;
  readonly probeIntervalMs?: number;
  readonly probe?: (socketPath: string) => Promise<boolean>;
  readonly spawnDetached?: (launch: DaemonLaunchSpec) => Promise<void>;
  readonly onProgress?: (progress: DaemonStartProgress) => void;
}): Promise<DaemonAutostartResult> {
  const readyTimeoutMs = input.readyTimeoutMs ?? 10_000,
    probeIntervalMs = input.probeIntervalMs ?? 50;
  const probe = input.probe ?? daemonSocketProbe,
    spawnDetached =
      input.spawnDetached ??
      ((launch: DaemonLaunchSpec) =>
        startDetachedProcessChecked(launch.command, launch.args, launch.env, daemonLaunchOutputPath(launch)));
  // A freshly started daemon can die between binding its socket and finishing
  // startup; confirm readiness with a second probe before declaring success.
  const ready = async () => {
    if (!(await probe(input.socketPath))) return false;
    await delay(probeIntervalMs);
    return probe(input.socketPath);
  };
  if (await ready()) return { ok: true, hint: "daemon is reachable", attempts: 0 };
  let launched: DaemonLaunchSpec | null = null,
    flight: Awaited<ReturnType<typeof acquireDaemonAutostartFlight>> | null = null,
    spawned = false,
    latestProgress: DaemonStartProgress | null = null,
    reported = "";
  try {
    launched = input.launch();
    const target = daemonLaunchTarget(launched);
    if (!target) throw new Error("daemon launch spec does not declare its --user-root and --daemon-id");
    flight = await acquireDaemonAutostartFlight(target);
    // The probe belongs inside the claim: another caller may have bound the
    // socket between this process's initial probe and atomic lock creation.
    if (flight.owner && (await ready())) return { ok: true, hint: "daemon is reachable", attempts: 0 };
    // A peer may have claimed the daemon singleton after the initial socket
    // probe but before this process claimed the autostart flight. That peer is
    // already the writer for this target; spawning a deferred candidate adds
    // noise and can make a GUI startup look like a writer-lock collision.
    if (flight.owner && !liveDaemonSingleton(launched)) {
      spawned = true;
      await spawnDetached(launched);
    }
    const startedAt = Date.now(),
      quietDeadline = startedAt + readyTimeoutMs,
      progressDeadline = startedAt + readyTimeoutMs * 6;
    for (;;) {
      if (await ready()) return { ok: true, hint: "daemon is reachable", attempts: spawned ? 1 : 0 };
      const progress = readDaemonStartProgress(launched, Date.now() - startedAt);
      if (progress) {
        latestProgress = progress;
        const key = `${progress.fingerprint}:${Math.floor((Date.now() - startedAt) / 1_000)}`;
        if (key !== reported) {
          reported = key;
          input.onProgress?.(progress);
        }
      }
      const deadline = latestProgress ? progressDeadline : quietDeadline;
      if (Date.now() >= deadline) break;
      await delay(probeIntervalMs);
    }
  } catch (error) {
    return { ok: false, attempts: spawned ? 1 : 0, ...classifySpawnFailure(error, launched) };
  } finally {
    flight?.release();
  }
  if (latestProgress)
    return {
      ok: false,
      code: "daemon_starting",
      attempts: spawned ? 1 : 0,
      hint: `${latestProgress.message}; the daemon is still alive but has not bound ${
        input.socketPath
      }. Keep waiting or inspect ${launched ? daemonLaunchOutputPath(launched) : "the lifecycle log"}.`,
    };
  return {
    ok: false,
    code: "daemon_bind_timeout",
    attempts: spawned ? 1 : 0,
    hint: `Daemon start failed: no socket appeared at ${
      input.socketPath
    } and no live lifecycle progress was observed within ${readyTimeoutMs}ms after one shared start attempt. Inspect ${
      launched ? daemonLaunchOutputPath(launched) : "the daemon lifecycle log"
    }.`,
  };
}
export function daemonLaunchOutputPath(launch: DaemonLaunchSpec): string | undefined {
  const target = daemonLaunchTarget(launch);
  return target ? daemonLifecycleLogPath(target.userRoot, target.daemonId) : undefined;
}
export function readDaemonStartProgress(launch: DaemonLaunchSpec, waitedMs: number): DaemonStartProgress | null {
  const target = daemonLaunchTarget(launch);
  if (!target) return null;
  const records = readDaemonLifecycleRecords(target.userRoot, target.daemonId),
    start = records.findLastIndex((record) => record.event === "process_start");
  if (start < 0) return null;
  const generation = records.slice(start),
    processRecord = generation[0]!;
  if (!daemonProcessAlive(processRecord.pid)) return null;
  for (let index = generation.length - 1; index >= 0; index -= 1) {
    const record = generation[index]!;
    if (record.event !== "repo_attach_started") continue;
    const settled = generation
      .slice(index + 1)
      .some(
        (later) =>
          later.repoId === record.repoId &&
          (later.event === "repo_attach_completed" ||
            later.event === "repo_attach_failed" ||
            later.event === "repo_attach_timed_out"),
      );
    if (!settled && record.repoId && record.attachIndex && record.attachTotal)
      return {
        fingerprint: `${record.at}:${record.event}:${record.repoId}`,
        message: `daemon is starting; waited ${Math.floor(waitedMs / 1_000)}s (repo ${record.attachIndex}/${
          record.attachTotal
        }: ${record.repoId})`,
      };
  }
  const latest = generation.at(-1)!,
    stage = startStage(latest);
  return {
    fingerprint: `${latest.at}:${latest.event}`,
    message: `daemon is starting; waited ${Math.floor(waitedMs / 1_000)}s (${stage})`,
  };
}
function startStage(latest: {
  readonly event: string;
  readonly attachIndex?: number;
  readonly attachTotal?: number;
  readonly unavailable?: number;
  readonly pruned?: number;
}): string {
  if (latest.event === "attachments_settled")
    return `all repositories settled${latest.unavailable ? ` (${latest.unavailable} unavailable)` : ""}${
      latest.pruned ? ` (${latest.pruned} pruned)` : ""
    }; daemon completing startup after attach`;
  if (latest.event === "repo_registry_pruned")
    return "retired a stale registry entry whose root no longer exists; continuing startup";
  if (latest.event === "socket_bound") return "socket bound; preparing repositories";
  if (latest.event === "repo_attach_timed_out") return `repository attach exceeded its budget; daemon moved on`;
  if (latest.attachIndex && latest.attachTotal)
    return latest.attachIndex >= latest.attachTotal
      ? `all ${latest.attachTotal} repositories attached; daemon completing startup`
      : `repository ${latest.attachIndex}/${latest.attachTotal} settled; preparing the next repository`;
  return "initializing before socket bind";
}
export { daemonSocketProbe };
function classifySpawnFailure(
  error: unknown,
  launch: DaemonLaunchSpec | null,
): { readonly code: DaemonAutostartFailureCode; readonly hint: string } {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string"
      ? (error as { readonly code: string }).code
      : null;
  const detail = error instanceof Error ? error.message : String(error),
    command = launch ? `${launch.command} ${launch.args.join(" ")}` : "the daemon launcher";
  if (code === "ENOENT")
    return {
      code: "daemon_spawn_not_found",
      hint: `Starting the daemon failed because the launcher binary was not found (ENOENT): ${
        detail
      }. Command: ${command}.`,
    };
  if (code === "EACCES" || code === "EPERM")
    return {
      code: "daemon_spawn_permission",
      hint: `Starting the daemon failed because permission was denied (${code}): ${detail}. Command: ${command}.`,
    };
  return { code: "daemon_start_failed", hint: `Starting the daemon failed: ${detail}. Command: ${command}.` };
}
function daemonLaunchTarget(launch: DaemonLaunchSpec): { readonly userRoot: string; readonly daemonId: string } | null {
  const daemon = launch.args.indexOf("daemon"),
    serve = daemon < 0 ? -1 : launch.args.indexOf("serve", daemon + 1),
    rootAt = launch.args.indexOf("--user-root", serve + 1),
    idAt = launch.args.indexOf("--daemon-id", serve + 1),
    userRoot = launch.args[rootAt + 1],
    daemonId = launch.args[idAt + 1];
  return daemon >= 0 && serve === daemon + 1 && rootAt >= 0 && idAt >= 0 && userRoot && daemonId
    ? { userRoot: path.resolve(userRoot), daemonId }
    : null;
}
function liveDaemonSingleton(launch: DaemonLaunchSpec): boolean {
  const target = daemonLaunchTarget(launch);
  if (!target) return false;
  const pid = readDaemonSingletonLockPid(target.userRoot, target.daemonId);
  return pid !== null && daemonProcessAlive(pid);
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
