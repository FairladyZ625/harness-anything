import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  consumeKnownError,
  resolveHarnessLayout,
  settingBlockValue,
  type AgentRuntimeEventV1,
} from "../../kernel/src/index.ts";
import { readDispatchStreams } from "./dispatch-stream.ts";
import type { RepoCell, RepoCellBinding } from "./repo-cell.ts";
import type { RuntimeDaemonRoute } from "./runtime-spawn.ts";

export const e2eProbePromptSource = "daemon:e2e-probe-scheduler";
export const e2eProbeIntervalMs = 2 * 60 * 60 * 1_000;

const defaults = Object.freeze({
  agentId: "e2e-probe",
  runtimeInstanceId: "test-codex-sol",
  model: "gpt-5.6-terra",
  effort: "low",
});

export interface E2EProbeScheduleConfig {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly agentId: string;
  readonly runtimeInstanceId: string;
  readonly model: string;
  readonly effort: string;
  readonly source: string;
  readonly error: string | null;
}

interface E2EProbeLastRun {
  readonly runtimeSessionId: string | null;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly runtimeOutcome: string;
  readonly probeOutcome: "healthy" | "failed" | "invalid_result" | "launch_failed";
  readonly failureSignature: string | null;
  readonly taskId: string | null;
  readonly deduplicated: boolean | null;
  readonly error: string | null;
}

interface E2EProbeSchedule {
  readonly repoId: string;
  readonly rootDir: string;
  readonly cell: RepoCell;
  readonly config: E2EProbeScheduleConfig;
  nextRunAt: string | null;
  lastRun: E2EProbeLastRun | null;
}

interface E2EProbeActiveRun {
  readonly token: symbol;
  readonly repoId: string;
  readonly startedAt: string;
  runtimeSessionId: string | null;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface E2EProbeSchedulerStatus {
  readonly schema: "daemon-e2e-probe-status/v1";
  readonly started: boolean;
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly running: {
    readonly repoId: string;
    readonly runtimeSessionId: string | null;
    readonly startedAt: string;
  } | null;
  readonly repos: readonly {
    readonly repoId: string;
    readonly enabled: boolean;
    readonly state: "disabled" | "configuration_error" | "scheduled" | "running";
    readonly source: string;
    readonly nextRunAt: string | null;
    readonly error: string | null;
    readonly lastRun: E2EProbeLastRun | null;
  }[];
}

export function resolveE2EProbeSchedule(rootDir: string): E2EProbeScheduleConfig {
  const configPath = path.join(resolveHarnessLayout(rootDir).authoredRoot, "harness.yaml"),
    source = "settings.e2eProbe";
  if (!existsSync(configPath)) return disabledSchedule(source);
  const body = readFileSync(configPath, "utf8"),
    values = {
      enabled: settingBlockValue(body, "e2eProbe", "enabled"),
      every: settingBlockValue(body, "e2eProbe", "every"),
      agent: settingBlockValue(body, "e2eProbe", "agent"),
      runtimeInstance: settingBlockValue(body, "e2eProbe", "runtimeInstance"),
      model: settingBlockValue(body, "e2eProbe", "model"),
      effort: settingBlockValue(body, "e2eProbe", "effort"),
    };
  // Repository-wide implicit enablement would make every checkout spend provider quota and
  // fail on a private Agent/Runtime name. Declaring the block opts the repository in; once
  // declared, enabled defaults true and the remaining values have the canonical defaults.
  if (Object.values(values).every((value) => value === undefined)) return disabledSchedule(source);
  if (values.enabled !== undefined && !["true", "false"].includes(values.enabled))
    return invalidSchedule(source, `${source}.enabled must be true or false.`);
  if (values.every !== undefined && values.every !== "2h")
    return invalidSchedule(source, `${source}.every must be 2h.`);
  for (const [key, value] of Object.entries(values))
    if (key !== "enabled" && key !== "every" && value !== undefined && !value.trim())
      return invalidSchedule(source, `${source}.${key} must be non-empty.`);
  return {
    enabled: values.enabled !== "false",
    intervalMs: e2eProbeIntervalMs,
    agentId: values.agent ?? defaults.agentId,
    runtimeInstanceId: values.runtimeInstance ?? defaults.runtimeInstanceId,
    model: values.model ?? defaults.model,
    effort: values.effort ?? defaults.effort,
    source,
    error: null,
  };
}

export function makeE2EProbeScheduler(input: {
  readonly cells: ReadonlyMap<string, RepoCell>;
  readonly daemonRoute: RuntimeDaemonRoute;
  readonly binding: RepoCellBinding;
  readonly now?: () => string;
  readonly setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly clearTimer?: (timer: TimerHandle) => void;
  readonly nodeExecutable?: string;
}) {
  const now = input.now ?? (() => new Date().toISOString()),
    setTimer = input.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs)),
    clearTimer = input.clearTimer ?? clearTimeout,
    schedules = new Map<string, E2EProbeSchedule>();
  let started = false,
    closed = false,
    timer: TimerHandle | null = null,
    active: E2EProbeActiveRun | null = null;

  const status = (): E2EProbeSchedulerStatus => ({
    schema: "daemon-e2e-probe-status/v1",
    started,
    enabled: [...schedules.values()].some(({ config }) => config.enabled && config.error === null),
    intervalMs: e2eProbeIntervalMs,
    running: active
      ? { repoId: active.repoId, runtimeSessionId: active.runtimeSessionId, startedAt: active.startedAt }
      : null,
    repos: [...schedules.values()]
      .sort((left, right) => left.repoId.localeCompare(right.repoId))
      .map((schedule) => ({
        repoId: schedule.repoId,
        enabled: schedule.config.enabled,
        state:
          active?.repoId === schedule.repoId
            ? "running"
            : schedule.config.error
              ? "configuration_error"
              : schedule.config.enabled
                ? "scheduled"
                : "disabled",
        source: schedule.config.source,
        nextRunAt: schedule.nextRunAt,
        error: schedule.config.error,
        lastRun: schedule.lastRun,
      })),
  });

  const start = async (): Promise<void> => {
    if (started || closed) return;
    started = true;
    for (const [repoId, cell] of input.cells) {
      const cellStatus = cell.status(),
        config = resolveE2EProbeSchedule(cellStatus.rootDir),
        schedule: E2EProbeSchedule = {
          repoId,
          rootDir: cellStatus.rootDir,
          cell,
          config,
          nextRunAt: config.enabled && config.error === null ? now() : null,
          lastRun: null,
        };
      schedules.set(repoId, schedule);
      if (config.enabled && config.error === null) await hydrate(schedule);
    }
    arm();
  };

  const close = (): void => {
    closed = true;
    if (timer) clearTimer(timer);
    timer = null;
  };

  const onRuntimeOutcome = async (
    repoId: string,
    event: Extract<AgentRuntimeEventV1, { readonly type: "runtime_session_outcome_observed" }>,
  ): Promise<void> => {
    const current = active;
    if (
      !current ||
      current.repoId !== repoId ||
      (current.runtimeSessionId !== null && current.runtimeSessionId !== event.payload.runtimeSessionId)
    )
      return;
    current.runtimeSessionId = event.payload.runtimeSessionId;
    await settle(schedules.get(repoId)!, event.payload.runtimeSessionId, now(), current.token);
  };

  async function hydrate(schedule: E2EProbeSchedule): Promise<void> {
    const latest = readDispatchStreams(schedule.rootDir)
      .filter(
        ({ header }) =>
          header.taskId === null &&
          header.agentId === schedule.config.agentId &&
          header.promptSource === e2eProbePromptSource,
      )
      .sort((left, right) => right.header.startedAt.localeCompare(left.header.startedAt))[0];
    if (!latest) return;
    try {
      const read = await latestSession(schedule.cell, latest.header.runtimeSessionId);
      if (read.session.activity.outcome === null) {
        active = {
          token: Symbol("adopted-e2e-probe"),
          repoId: schedule.repoId,
          runtimeSessionId: latest.header.runtimeSessionId,
          startedAt: latest.header.startedAt,
        };
        schedule.nextRunAt = null;
        return;
      }
      schedule.lastRun = lastRunFromRead(read, latest.header.startedAt);
      schedule.nextRunAt = nextRunAt(read.session.activity.lastObservedAt, schedule.config.intervalMs, now());
    } catch (error) {
      consumeKnownError(error);
      schedule.lastRun = invalidResult(latest.header.runtimeSessionId, latest.header.startedAt, now(), error);
      schedule.nextRunAt = nextRunAt(now(), schedule.config.intervalMs, now());
    }
  }

  function arm(): void {
    if (closed || !started || active) return;
    if (timer) clearTimer(timer);
    timer = null;
    const due = [...schedules.values()]
      .filter(({ config, nextRunAt }) => config.enabled && config.error === null && nextRunAt !== null)
      .sort((left, right) => left.nextRunAt!.localeCompare(right.nextRunAt!))[0];
    if (!due) return;
    const delayMs = Math.max(0, Date.parse(due.nextRunAt!) - Date.parse(now()));
    timer = setTimer(() => {
      timer = null;
      void tick();
    }, delayMs);
    timer.unref?.();
  }

  async function tick(): Promise<void> {
    if (closed || active) return;
    const observedAt = now(),
      due = [...schedules.values()]
        .filter(
          ({ config, nextRunAt }) =>
            config.enabled && config.error === null && nextRunAt !== null && nextRunAt <= observedAt,
        )
        .sort((left, right) => left.nextRunAt!.localeCompare(right.nextRunAt!))[0];
    if (!due) {
      arm();
      return;
    }
    const token = Symbol("e2e-probe-run");
    active = { token, repoId: due.repoId, runtimeSessionId: null, startedAt: observedAt };
    due.nextRunAt = null;
    try {
      const receipt = await due.cell.spawnRuntime(
        {
          runtimeInstanceId: due.config.runtimeInstanceId,
          agentId: due.config.agentId,
          model: due.config.model,
          effort: due.config.effort,
          cwd: { scope: "repo-root" },
          prompt: probeMission(due, observedAt),
          promptSource: e2eProbePromptSource,
          idempotencyKey: `e2e-probe:${due.repoId}:${observedAt}`,
        },
        input.binding,
      );
      if (active?.token === token) active.runtimeSessionId = requiredProbeRuntimeSessionId(receipt.runtimeSessionId);
    } catch (error) {
      consumeKnownError(error);
      if (active?.token !== token) return;
      due.lastRun = {
        runtimeSessionId: null,
        startedAt: observedAt,
        endedAt: now(),
        runtimeOutcome: "launch_failed",
        probeOutcome: "launch_failed",
        failureSignature: null,
        taskId: null,
        deduplicated: null,
        error: error instanceof Error ? error.message : String(error),
      };
      due.nextRunAt = nextRunAt(now(), due.config.intervalMs, now());
      active = null;
      arm();
    }
  }

  async function settle(
    schedule: E2EProbeSchedule,
    runtimeSessionId: string,
    endedAt: string,
    token: symbol,
  ): Promise<void> {
    try {
      const read = await latestSession(schedule.cell, runtimeSessionId);
      schedule.lastRun = lastRunFromRead(read, active?.startedAt ?? endedAt);
    } catch (error) {
      consumeKnownError(error);
      schedule.lastRun = invalidResult(runtimeSessionId, active?.startedAt ?? endedAt, endedAt, error);
    }
    schedule.nextRunAt = nextRunAt(endedAt, schedule.config.intervalMs, now());
    if (active?.token === token) active = null;
    arm();
  }

  function probeMission(schedule: E2EProbeSchedule, scheduledAt: string): string {
    const environment = [
      ["HARNESS_CANONICAL_ROOT", schedule.rootDir],
      ["HARNESS_DAEMON_USER_ROOT", input.daemonRoute.userRoot],
      ["HARNESS_DAEMON_ID", input.daemonRoute.daemonId],
      ["HARNESS_DAEMON_ENDPOINT", input.daemonRoute.endpoint],
      ["HARNESS_DAEMON_REPO_ID", schedule.repoId],
      ["HARNESS_ACTOR", `agent:${schedule.config.agentId}`],
    ]
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(" ");
    const command = `${environment} ${shellQuote(input.nodeExecutable ?? process.execPath)} tools/e2e-probe.mjs --agent-run`;
    return [
      "Run the canonical E2E health probe exactly once.",
      `Scheduled at: ${scheduledAt}`,
      `Command: ${command}`,
      "The command owns the read-only GUI journey and the failure-task dedupe closure.",
      "Do not inject a fault, create any other task, edit source files, or run another command.",
      "Return the command's single JSON stdout object exactly, without Markdown fences or commentary.",
    ].join("\n");
  }

  return { start, close, status, onRuntimeOutcome };
}

function disabledSchedule(source: string): E2EProbeScheduleConfig {
  return { enabled: false, intervalMs: e2eProbeIntervalMs, ...defaults, source, error: null };
}

function invalidSchedule(source: string, error: string): E2EProbeScheduleConfig {
  return { enabled: false, intervalMs: e2eProbeIntervalMs, ...defaults, source, error };
}

function nextRunAt(from: string, intervalMs: number, floor: string): string {
  return new Date(Math.max(Date.parse(floor), Date.parse(from) + intervalMs)).toISOString();
}

function requiredProbeRuntimeSessionId(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("E2E probe runtime receipt omitted runtimeSessionId.");
  return value;
}

async function latestSession(cell: RepoCell, runtimeSessionId: string): Promise<any> {
  return cell.read("repo.agentRuntime.sessions.read", { runtimeSessionId });
}

function lastRunFromRead(read: any, startedAt: string): E2EProbeLastRun {
  const endedAt =
      typeof read.session.activity.lastObservedAt === "string" ? read.session.activity.lastObservedAt : startedAt,
    runtimeOutcome = String(read.session.activity.outcome ?? "unknown");
  if (runtimeOutcome !== "succeeded")
    return {
      runtimeSessionId: read.session.runtimeSessionId,
      startedAt,
      endedAt,
      runtimeOutcome,
      probeOutcome: "invalid_result",
      failureSignature: null,
      taskId: null,
      deduplicated: null,
      error: `Probe runtime settled ${runtimeOutcome}.`,
    };
  try {
    const result = parseProbeResult(read.result?.text);
    return {
      runtimeSessionId: read.session.runtimeSessionId,
      startedAt,
      endedAt,
      runtimeOutcome,
      probeOutcome: result.outcome,
      failureSignature: result.failureSignature,
      taskId: result.taskId,
      deduplicated: result.deduplicated,
      error: null,
    };
  } catch (error) {
    return invalidResult(read.session.runtimeSessionId, startedAt, endedAt, error, runtimeOutcome);
  }
}

function parseProbeResult(value: unknown): {
  readonly outcome: "healthy" | "failed";
  readonly failureSignature: string | null;
  readonly taskId: string | null;
  readonly deduplicated: boolean | null;
} {
  if (typeof value !== "string") throw new Error("Probe runtime result is missing.");
  const trimmed = value
      .trim()
      .replace(/^```(?:json)?\s*/u, "")
      .replace(/\s*```$/u, ""),
    parsed: unknown = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Probe result must be an object.");
  const record = parsed as Record<string, unknown>;
  if (record.schema !== "e2e-probe-result/v1" || !["healthy", "failed"].includes(String(record.outcome)))
    throw new Error("Probe result must use e2e-probe-result/v1 with healthy or failed outcome.");
  return {
    outcome: record.outcome as "healthy" | "failed",
    failureSignature: typeof record.failureSignature === "string" ? record.failureSignature : null,
    taskId: typeof record.taskId === "string" ? record.taskId : null,
    deduplicated: typeof record.deduplicated === "boolean" ? record.deduplicated : null,
  };
}

function invalidResult(
  runtimeSessionId: string,
  startedAt: string,
  endedAt: string,
  error: unknown,
  runtimeOutcome = "succeeded",
): E2EProbeLastRun {
  return {
    runtimeSessionId,
    startedAt,
    endedAt,
    runtimeOutcome,
    probeOutcome: "invalid_result",
    failureSignature: null,
    taskId: null,
    deduplicated: null,
    error: error instanceof Error ? error.message : String(error),
  };
}

function shellQuote(value: string): string {
  const escaped = value.replaceAll("'", "'\"'\"'");
  return `'${escaped}'`;
}
