import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { accepted, nonEmpty, optionalFlags, readFlags, rejected } from "./thin-command-flags.ts";
import type { ProtocolCommand, ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

const durationUnits = Object.freeze({ s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 });

export function parseSchedule(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  if (route.id === "schedule-list")
    return args.length === 2
      ? accepted(rootDir, repoId, json, { kind: "schedule-list" })
      : rejected("unknown_field", "ha schedule list takes no options or positional arguments.", json);
  const scheduleId = args[2];
  if (!nonEmpty(scheduleId))
    return rejected("missing_field", `Use ha schedule ${args[1] ?? "<command>"} <schedule-id>.`, json);
  const flags = readFlags(route.id, args.slice(3), inputs);
  if (!flags.ok) return rejected(flags.code, flags.nextAction, json);
  const idempotencyKey = flags.one.get("--idempotency-key"),
    retry = idempotencyKey ? { idempotencyKey } : {};
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
      updateFlags = [
        "--name",
        "--every",
        "--agent",
        "--instance",
        "--mission",
        "--mission-file",
        "--model",
        "--effort",
        "--cwd",
      ];
    if (mission && missionFile)
      return rejected("invalid_field", "Use --mission <text> or --mission-file <path>, not both.", json);
    if (!updateFlags.some((flag) => flags.one.has(flag)))
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
        ["--agent", "agentId"],
        ["--instance", "runtimeInstanceId"],
        ["--model", "model"],
        ["--effort", "reasoningEffort"],
        ["--cwd", "cwd"],
      ]),
      ...(everyMs === undefined ? {} : { everyMs }),
      ...(mission ? { mission } : missionFile ? { missionFile } : {}),
      ...retry,
    });
  }
  if (route.id !== "schedule-create") return accepted(rootDir, repoId, json, { kind: route.id, scheduleId, ...retry });
  const mission = flags.one.get("--mission"),
    missionFile = flags.one.get("--mission-file");
  if (Boolean(mission) === Boolean(missionFile))
    return rejected("missing_field", "Use exactly one of --mission <text> or --mission-file <path>.", json);
  const every = flags.one.get("--every")!,
    everyMs = parseScheduleDuration(every);
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
    everyMs,
    agentId: flags.one.get("--agent"),
    runtimeInstanceId: flags.one.get("--instance"),
    ...(mission ? { mission } : { missionFile }),
    ...optionalFlags(flags.one, [
      ["--model", "model"],
      ["--effort", "reasoningEffort"],
      ["--cwd", "cwd"],
    ]),
    ...(flags.booleans.has("--disabled") ? { disabled: true } : {}),
    ...retry,
  });
}

export function parseScheduleDuration(value: string): number | null {
  const match = /^(\d+)([smhd])$/u.exec(value);
  if (!match) return null;
  const amount = Number(match[1]),
    milliseconds = amount * durationUnits[match[2] as keyof typeof durationUnits];
  return Number.isSafeInteger(milliseconds) && milliseconds >= 60_000 ? milliseconds : null;
}

export function renderScheduleList(receipt: Record<string, unknown>): string | null {
  if (receipt.command !== "schedule-list" || !Array.isArray(receipt.schedules)) return null;
  if (receipt.schedules.length === 0) return "No schedules.";
  return receipt.schedules
    .map((value) => {
      const row = value as Record<string, unknown>,
        status = row.status && typeof row.status === "object" ? (row.status as Record<string, unknown>) : null;
      return [row.scheduleId, row.state, row.nextRunAt ?? "none", status?.activeRun ? "active" : "idle"]
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
