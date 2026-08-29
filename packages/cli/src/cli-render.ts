import type { RuntimeBatchResult } from "./cli-types.ts";
import { cliErrorMessage } from "./cli-error.ts";
import { consumeKnownError } from "./daemon/client.ts";

type ReceiptFailure =
  | { readonly _tag: "ReceiptFailure"; readonly errorCode: string; readonly hint: string }
  | {
      readonly _tag: "SquadLeaderFailure";
      readonly errorCode: string;
      readonly leader: { readonly code: string; readonly hint: string };
    };

type CliDispatchFailure =
  | { readonly _tag: "DirectDaemonFailure"; readonly errorCode: string; readonly message: string }
  | { readonly _tag: "DaemonResponseTimeout"; readonly errorCode: string; readonly message: string }
  | { readonly _tag: "DaemonUnavailable"; readonly errorCode: string; readonly message: string };

export function humanError(receipt: Record<string, unknown>): {
  readonly code: string;
  readonly hint: string;
} {
  const outer = receipt.error && typeof receipt.error === "object" ? (receipt.error as Record<string, unknown>) : {},
    code = typeof outer.code === "string" ? outer.code : typeof receipt.code === "string" ? receipt.code : "unknown",
    hint =
      typeof outer.hint === "string"
        ? outer.hint
        : typeof receipt.nextAction === "string"
          ? receipt.nextAction
          : typeof receipt.next === "string"
            ? receipt.next
            : "Command failed.",
    leader = receipt.leader && typeof receipt.leader === "object" ? (receipt.leader as Record<string, unknown>) : null,
    nested = leader ? humanError(leader) : null,
    failure: ReceiptFailure =
      code === "squad_leader_failed" && nested && nested.code !== "unknown"
        ? { _tag: "SquadLeaderFailure", errorCode: code, leader: nested }
        : { _tag: "ReceiptFailure", errorCode: code, hint };
  switch (failure._tag) {
    case "ReceiptFailure":
      return { code: failure.errorCode, hint: failure.hint };
    case "SquadLeaderFailure":
      return {
        code: failure.errorCode,
        hint: `Leader dispatch rejected: code=${failure.leader.code} hint=${failure.leader.hint}`,
      };
  }
}

export function cliDispatchError(input: {
  readonly error: unknown;
  readonly directCode: string | null;
  readonly timeoutCode: "daemon_response_timeout" | null;
}): { readonly code: string; readonly hint: string } {
  const message = cliErrorMessage(input.error);
  let failure: CliDispatchFailure;
  if (input.directCode !== null) failure = { _tag: "DirectDaemonFailure", errorCode: input.directCode, message };
  else if (input.timeoutCode !== null)
    failure = { _tag: "DaemonResponseTimeout", errorCode: input.timeoutCode, message };
  else failure = { _tag: "DaemonUnavailable", errorCode: "daemon_unavailable", message };
  switch (failure._tag) {
    case "DirectDaemonFailure":
      return { code: failure.errorCode, hint: failure.message };
    case "DaemonResponseTimeout":
    case "DaemonUnavailable":
      return { code: failure.errorCode, hint: `Local daemon request failed. Cause: ${failure.message}` };
  }
}

export function renderRuntimeBatchRow(value: unknown): string {
  const row = value as Partial<RuntimeBatchResult>;
  const fields = [
    row.index,
    row.instance,
    row.status,
    `dispatch:${String(row.dispatchId ?? "-")}`,
    `session:${String(row.runtimeSessionId ?? "-")}`,
    `code:${String(row.code ?? "-")}`,
    `reason:${String(row.reason ?? "-")}`,
  ];
  return `${fields.map(String).join("\t")}${row.reportPath ? `\treport:${row.reportPath}` : ""}`;
}

export function renderDispatchRow(value: unknown): string {
  const row = value as Partial<Record<string, unknown>> & {
    readonly exitCode?: number | null;
    readonly resultRef?: string | null;
    readonly dispatchPath?: string | null;
    readonly reportPath?: string | null;
  };
  return [
    String(row.dispatchId),
    String(row.status),
    String(row.runtimeSessionId),
    String(row.outcome ?? "-"),
    `attempt:${String(row.attemptIndex ?? 0)}`,
    `provider:${String((row.provider as Record<string, unknown> | undefined)?.instance ?? row.instanceId ?? "-")}`,
    `model:${String((row.provider as Record<string, unknown> | undefined)?.model ?? "-")}`,
    `classification:${String(row.classification ?? "-")}`,
    `fallback:${String(row.fallbackState ?? "-")}`,
    `worker:${String(row.agentId ?? "-")}`,
    `leader:${String(row.delegatedByAgentId ?? "-")}`,
    `squad:${String(row.squadId ?? "-")}`,
    `code:${String(row.code ?? "-")}`,
    `reason:${String(row.reason ?? "-")}`,
    `exit:${String(row.exitCode ?? "-")}`,
    `result:${String(row.resultRef ?? "-")}`,
    `dispatch:${String(row.dispatchPath ?? "-")}`,
    `report:${String(row.reportPath ?? "-")}`,
  ].join("\t");
}

export function contractMigrationDryRunSummary(receipt: Record<string, unknown>): string | undefined {
  if (receipt.command !== "task-contract-migrate" || typeof receipt.evidence !== "string") return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(receipt.evidence);
  } catch (error) {
    consumeKnownError(error);
    return undefined;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const report = (payload as Record<string, unknown>).report,
    manual = (payload as Record<string, unknown>).manual;
  if ((payload as Record<string, unknown>).applied !== false || !Array.isArray(report) || !Array.isArray(manual))
    return undefined;
  const rows = report.map(renderReceiptRow),
    scalars = Object.entries(payload)
      .filter(([key, value]) => key !== "report" && key !== "manual" && (value === null || typeof value !== "object"))
      .map(([key, value]) => `${key}=${String(value)}`)
      .join("  ");
  return [`report:\n${rows.length ? rows.join("\n") : "(none)"}`, scalars].filter(Boolean).join("\n");
}

export function renderReceiptRow(row: unknown): string {
  return row && typeof row === "object" && !Array.isArray(row)
    ? Object.values(row)
        .filter((value) => value === null || typeof value !== "object")
        .map((value) => String(value))
        .join("\t")
    : String(row);
}
