import {
  isRuntimeEventApprovalDecision,
  isRuntimeEventInterruptAction,
  isRuntimeEventKind,
  isRuntimeEventResultStatus,
  type RuntimeEventApprovalDecision,
  type RuntimeEventInterruptAction,
  type RuntimeEventRuntime,
  type RuntimeEventResultStatus
} from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

const runtimes = new Set(["human", "claude-code", "codex", "zcode", "antigravity", "unknown"]);

export function parseRuntimeEventArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  const normalizedArgs = args[0] === "event" ? ["runtime-event", ...args.slice(1)] : args;
  if (normalizedArgs[0] !== "runtime-event") return null;
  if (normalizedArgs[1] === "list") return parseRuntimeEventList(normalizedArgs, rootDir, json);
  if (normalizedArgs[1] !== "append") return null;
  const sessionId = readOption(normalizedArgs, "--session");
  const kind = readOption(normalizedArgs, "--kind");
  if (!sessionId) return { ok: false, error: cliError(CliErrorCode.MissingSession, "Use event append --session <session-id>.") };
  if (!kind || !isRuntimeEventKind(kind)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidRuntimeEventKind, "Use session, turn, step, tool, approval, interrupt, result, or cost for --kind.") };
  }
  const runtime = readOption(normalizedArgs, "--runtime") ?? "unknown";
  if (!runtimes.has(runtime)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidRuntimeEventValue, "Use a known runtime or unknown for --runtime.") };
  }
  const approval = readOption(normalizedArgs, "--approval");
  if (approval && !isRuntimeEventApprovalDecision(approval)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidRuntimeEventValue, "Use approved, rejected, timeout, or unknown for --approval.") };
  }
  const interrupt = readOption(normalizedArgs, "--interrupt");
  if (interrupt && !isRuntimeEventInterruptAction(interrupt)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidRuntimeEventValue, "Use pause, cancel, resume, append, branch, or unknown for --interrupt.") };
  }
  const result = readOption(normalizedArgs, "--result");
  if (result && !isRuntimeEventResultStatus(result)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidRuntimeEventValue, "Use started, succeeded, failed, cancelled, or unknown for --result.") };
  }
  const totalTokens = parseOptionalNumber(readOption(normalizedArgs, "--total-tokens"));
  if (totalTokens === null) return { ok: false, error: cliError(CliErrorCode.InvalidRuntimeEventValue, "Use a numeric value for --total-tokens.") };
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "runtime-event-append",
        eventKind: kind,
        sessionId,
        runtime: runtime as RuntimeEventRuntime | "unknown",
        eventId: readOption(normalizedArgs, "--id"),
        recordedAt: readOption(normalizedArgs, "--at"),
        taskId: readOption(normalizedArgs, "--task"),
        turnId: readOption(normalizedArgs, "--turn"),
        stepId: readOption(normalizedArgs, "--step"),
        toolName: readOption(normalizedArgs, "--tool"),
        approval: approval as RuntimeEventApprovalDecision | undefined,
        interrupt: interrupt as RuntimeEventInterruptAction | undefined,
        result: result as RuntimeEventResultStatus | undefined,
        summary: readOption(normalizedArgs, "--summary"),
        totalTokens
      }
    }
  };
}

function parseRuntimeEventList(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const sessionId = readOption(args, "--session");
  if (!sessionId) return { ok: false, error: cliError(CliErrorCode.MissingSession, "Use event list --session <session-id>.") };
  return { ok: true, value: { rootDir, json, action: { kind: "runtime-event-list", sessionId } } };
}

function parseOptionalNumber(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  if (!/^\d+(?:\.\d+)?$/u.test(value)) return null;
  return Number(value);
}
