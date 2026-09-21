import type { SafePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import {
  parseScheduleListReceipt,
  type ScheduleListRow,
} from "@harness-anything/daemon/internal/protocol/daemon-protocol-validate-results";
import { parseScheduleDuration } from "@harness-anything/daemon/internal/protocol/daemon-protocol-vocabulary";
import { validateScheduleRuns, type ScheduleRunsResult } from "@harness-anything/daemon/internal/protocol/schedule-runs-contract";
import { consumeKnownError } from "../daemon/client.ts";
import { accepted, nonEmpty, optionalFlags, readFlags, rejected } from "./thin-command-flags.ts";
import type { ProtocolCommand, ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

export function parseSchedule(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const read = parseScheduleRead(route, args, rootDir, repoId, json, inputs);
  if (read) return read;
  const packetOnly = isPacketInputToken(args[2]),
    scheduleId = packetOnly ? undefined : args[2],
    flags = readFlags(route.id, args.slice(packetOnly ? 2 : 3), inputs);
  if (!flags.ok) return rejected(flags.code, flags.nextAction, json);
  const fromFile = flags.one.get("--from-file"),
    jsonInput = flags.one.get("--json-input");
  if (fromFile || jsonInput)
    return scheduleId === undefined && flags.one.size === 1
      ? accepted(rootDir, repoId, json, {
          kind: route.id,
          ...(fromFile ? { fromFile } : { jsonInput }),
        })
      : rejected(
          "invalid_field",
          "Use one of --from-file <path> or --json-input <json|@-> by itself, " +
            "or provide the direct Schedule arguments.",
          json,
        );
  if (!nonEmpty(scheduleId))
    return rejected("missing_field", `Use ha schedule ${args[1] ?? "<command>"} <schedule-id>.`, json);
  const idempotencyKey = flags.one.get("--idempotency-key"),
    retry = idempotencyKey ? { idempotencyKey } : {};
  if (route.id === "schedule-runs")
    return accepted(rootDir, repoId, json, {
      kind: route.id,
      scheduleId,
      ...(flags.one.has("--limit") ? { limit: Number(flags.one.get("--limit")) } : {}),
    });
  if (route.id === "schedule-delete")
    return accepted(rootDir, repoId, json, {
      kind: route.id,
      scheduleId,
      ...(flags.one.get("--reason") ? { reason: flags.one.get("--reason") } : {}),
      ...retry,
    });
  if (route.id === "schedule-update") {
    const mission = flags.one.get("--mission"),
      missionFile = flags.one.get("--mission-file"),
      every = flags.one.get("--every"),
      cronExpression = flags.one.get("--cron"),
      timezone = flags.one.get("--timezone"),
      keepDays = flags.one.get("--keep-days"),
      updateFlags = [
        "--name",
        "--mode",
        "--every",
        "--cron",
        "--timezone",
        "--agent",
        "--instance",
        "--mission",
        "--mission-file",
        "--model",
        "--effort",
        "--fast",
        "--keep-days",
        "--keep-monthly",
        "--no-keep-monthly",
      ];
    if (mission && missionFile)
      return rejected("invalid_field", "Use --mission <text> or --mission-file <path>, not both.", json);
    if (every && (cronExpression || timezone))
      return rejected("invalid_field", "Use --every or --cron/--timezone, not both.", json);
    if (cronExpression && !timezone) return rejected("missing_field", "Add --timezone <IANA-zone> with --cron.", json);
    if (!updateFlags.some((flag) => flags.one.has(flag) || flags.many.has(flag) || flags.booleans.has(flag)))
      return rejected("missing_field", "Change at least one Schedule definition field.", json);
    const everyMs = every === undefined ? undefined : parseScheduleDuration(every);
    if (everyMs === null)
      return rejected(
        "invalid_field",
        "Use --every with one whole-number interval such as 60s, 30m, 2h, or 1d; the minimum is 1m.",
        json,
      );
    return accepted(rootDir, repoId, json, {
      kind: route.id,
      scheduleId,
      ...optionalFlags(flags.one, [
        ["--name", "name"],
        ["--mode", "mode"],
        ["--agent", "agentId"],
        ["--instance", "runtimeInstanceId"],
        ["--model", "model"],
        ["--effort", "reasoningEffort"],
      ]),
      ...(everyMs === undefined ? {} : { everyMs }),
      ...(cronExpression === undefined ? {} : { cronExpression }),
      ...(timezone === undefined ? {} : { timezone }),
      ...(mission ? { mission } : missionFile ? { missionFile } : {}),
      ...(flags.booleans.has("--fast") ? { fast: true } : {}),
      ...scheduleRetentionUpdate(flags, keepDays),
      ...retry,
    });
  }
  if (route.id !== "schedule-create") return accepted(rootDir, repoId, json, { kind: route.id, scheduleId, ...retry });
  const mission = flags.one.get("--mission"),
    missionFile = flags.one.get("--mission-file"),
    every = flags.one.get("--every"),
    cronExpression = flags.one.get("--cron"),
    timezone = flags.one.get("--timezone");
  if (Boolean(mission) === Boolean(missionFile))
    return rejected("missing_field", "Use exactly one of --mission <text> or --mission-file <path>.", json);
  if (Boolean(every) === Boolean(cronExpression))
    return rejected("missing_field", "Use exactly one of --every <duration> or --cron <expression>.", json);
  if (cronExpression && !timezone) return rejected("missing_field", "Add --timezone <IANA-zone> with --cron.", json);
  if (!cronExpression && timezone) return rejected("invalid_field", "Use --timezone only with --cron.", json);
  const everyMs = every === undefined ? undefined : parseScheduleDuration(every);
  if (everyMs === null)
    return rejected(
      "invalid_field",
      "Use --every with one whole-number interval such as 60s, 30m, 2h, or 1d; the minimum is 1m.",
      json,
    );
  return accepted(rootDir, repoId, json, {
    kind: "schedule-create",
    scheduleId,
    name: flags.one.get("--name"),
    mode: flags.one.get("--mode"),
    ...(everyMs === undefined ? { cronExpression, timezone } : { everyMs }),
    agentId: flags.one.get("--agent"),
    runtimeInstanceId: flags.one.get("--instance"),
    ...(mission ? { mission } : { missionFile }),
    ...optionalFlags(flags.one, [
      ["--model", "model"],
      ["--effort", "reasoningEffort"],
    ]),
    ...(flags.booleans.has("--fast") ? { fast: true } : {}),
    ...(flags.booleans.has("--disabled") ? { disabled: true } : {}),
    ...retry,
  });
}

/** Retention parameters apply to the system-seeded builtin schedules only; the kernel rejects
 * them on agent schedules with invalid_command. `--keep-monthly` and `--no-keep-monthly` are
 * declared mutually exclusive by the protocol input, so only one can be present here. */
function scheduleRetentionUpdate(
  flags: { readonly booleans: ReadonlySet<string> },
  keepDays: string | undefined,
): { readonly keepDays?: number; readonly keepMonthly?: boolean } {
  return {
    ...(keepDays === undefined ? {} : { keepDays: Number(keepDays) }),
    ...(flags.booleans.has("--keep-monthly")
      ? { keepMonthly: true }
      : flags.booleans.has("--no-keep-monthly")
        ? { keepMonthly: false }
        : {}),
  };
}

function isPacketInputToken(value: string | undefined): boolean {
  return ["--from-file", "--json-input"].some((name) => value === name || value?.startsWith(`${name}=`) === true);
}

export function renderScheduleList(receipt: Record<string, unknown>): string | null {
  if (receipt.command !== "schedule-list") return null;
  let schedules: readonly ScheduleListRow[] | null;
  try {
    schedules = parseScheduleListReceipt(receipt);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
  if (!schedules) return null;
  if (schedules.length === 0) return "No schedules.";
  return schedules
    .map((row) => {
      if (row.state === "invalid") return [row.scheduleId, row.state, row.invalidReason].join("\t");
      return [row.scheduleId, row.state, row.nextRunAt ?? "none", row.status.activeRun ? "active" : "idle"]
        .map(String)
        .join("\t");
    })
    .join("\n");
}

export function renderScheduleShow(receipt: Record<string, unknown>): string | null {
  if (receipt.command !== "schedule-show" || receipt.schedule === null || typeof receipt.schedule !== "object")
    return null;
  return JSON.stringify(receipt.schedule, null, 2);
}

export function renderScheduleRuns(receipt: Record<string, unknown>): string | null {
  if (receipt.command !== "schedule-runs" || typeof receipt.evidence !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(receipt.evidence);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const { schema, ...result } = parsed as Record<string, unknown>;
    if (schema !== "schedule-runs/v1" || validateScheduleRuns(result).length) return null;
    const runs = (result as unknown as ScheduleRunsResult).runs;
    if (!runs.length) return "No Schedule occurrences.";
    return runs
      .map((run) =>
        [
          run.occurrenceId,
          run.scheduledFor,
          run.outcome,
          run.nodeId ?? "none",
          run.durationMs === null ? "none" : `${run.durationMs}ms`,
          run.reportRef ?? run.missedReason ?? "none",
        ].join("\t"),
      )
      .join("\n");
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

function parseScheduleRead(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult | null {
  if (route.id === "schedule-list")
    return args.length === 2
      ? accepted(rootDir, repoId, json, { kind: "schedule-list" })
      : rejected("unknown_field", "ha schedule list takes no options or positional arguments.", json);
  if (route.id !== "schedule-reckon") return null;
  const flags = readFlags(route.id, args.slice(2), inputs);
  return flags.ok
    ? accepted(rootDir, repoId, json, {
        kind: "schedule-reckon",
        ...(flags.one.has("--window-hours") ? { windowHours: Number(flags.one.get("--window-hours")) } : {}),
      })
    : rejected(flags.code, flags.nextAction, json);
}

export function renderScheduleReckon(receipt: Record<string, unknown>): string | null {
  if (receipt.command !== "schedule-reckon" || typeof receipt.evidence !== "string") return null;
  return `${JSON.stringify(JSON.parse(receipt.evidence), null, 2)}\n`;
}
