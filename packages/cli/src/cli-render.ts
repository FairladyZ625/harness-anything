import type { RuntimeBatchResult, SquadRunDispatch } from "./cli-types.ts";
import { consumeKnownError } from "./daemon/client.ts";

export function humanError(receipt: Record<string, unknown>): {
  readonly code: string;
  readonly hint: string;
} {
  const outer =
      receipt.error && typeof receipt.error === "object"
        ? (receipt.error as Record<string, unknown>)
        : {},
    code =
      typeof outer.code === "string"
        ? outer.code
        : typeof receipt.code === "string"
          ? receipt.code
          : "unknown",
    hint =
      typeof outer.hint === "string"
        ? outer.hint
        : typeof receipt.nextAction === "string"
          ? receipt.nextAction
          : typeof receipt.next === "string"
            ? receipt.next
            : "Command failed.",
    leader =
      receipt.leader && typeof receipt.leader === "object"
        ? (receipt.leader as Record<string, unknown>)
        : null,
    nested = leader ? humanError(leader) : null;
  return code === "squad_leader_failed" && nested && nested.code !== "unknown"
    ? {
        code,
        hint: `Leader dispatch rejected: code=${nested.code} hint=${nested.hint}`,
      }
    : { code, hint };
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

export function renderSquadRunRow(value: unknown): string {
  const row = value as Partial<SquadRunDispatch>;
  const fields = [
    row.dispatchId ?? "-",
    row.status,
    row.runtimeSessionId ?? "-",
    row.outcome ?? "-",
    `worker:${String(row.agentId ?? "-")}`,
    `leader:${String(row.delegatedByAgentId ?? "-")}`,
    `squad:${String(row.squadId ?? "-")}`,
    `code:${String(row.code ?? "-")}`,
    `reason:${String(row.reason ?? "-")}`,
  ];
  return `${fields.map(String).join("\t")}${row.reportPath ? `\treport:${row.reportPath}` : ""}`;
}

export function renderDispatchRow(value: unknown): string {
  const row = value as Partial<SquadRunDispatch> & {
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

export function contractMigrationDryRunSummary(
  receipt: Record<string, unknown>,
): string | undefined {
  if (
    receipt.command !== "task-contract-migrate" ||
    typeof receipt.evidence !== "string"
  )
    return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(receipt.evidence);
  } catch (error) {
    consumeKnownError(error);
    return undefined;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return undefined;
  const report = (payload as Record<string, unknown>).report,
    manual = (payload as Record<string, unknown>).manual;
  if (
    (payload as Record<string, unknown>).applied !== false ||
    !Array.isArray(report) ||
    !Array.isArray(manual)
  )
    return undefined;
  const rows = report.map(renderReceiptRow),
    scalars = Object.entries(payload)
      .filter(
        ([key, value]) =>
          key !== "report" &&
          key !== "manual" &&
          (value === null || typeof value !== "object"),
      )
      .map(([key, value]) => `${key}=${String(value)}`)
      .join("  ");
  return [`report:\n${rows.length ? rows.join("\n") : "(none)"}`, scalars]
    .filter(Boolean)
    .join("\n");
}

export function renderReceiptRow(row: unknown): string {
  return row && typeof row === "object" && !Array.isArray(row)
    ? Object.values(row)
        .filter((value) => value === null || typeof value !== "object")
        .map((value) => String(value))
        .join("\t")
    : String(row);
}
