import { contractMigrationDryRunSummary, renderDispatchRow, renderRuntimeBatchRow } from "../cli-render.ts";
import {
  renderEntityActionExplanation,
  type EntityActionExplanationRenderInput,
} from "./entity-action-explain-render.ts";
import { consumeKnownError } from "../daemon/client.ts";
import { humanError, renderReceiptGuidance } from "./guidance-plane.ts";
import { renderScheduleList, renderScheduleRuns, renderScheduleShow } from "./thin-command-schedule.ts";

export interface RenderedCliReceipt {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

type ReceiptRenderer = (receipt: Record<string, unknown>) => string;

const schemaRenderers = new Map<string, ReceiptRenderer>([
  [
    "entity-action-explanation/v1",
    (receipt) => renderEntityActionExplanation(receipt as unknown as EntityActionExplanationRenderInput),
  ],
]);

const commandRenderers = new Map<string, ReceiptRenderer>([
  ["task-create", renderTaskCreate],
  ["task-show", renderTaskShow],
  ["preset-list", renderPresetListReceipt],
  ["migrate-import", renderSuccessfulReceipt],
  ["task-contract-migrate", renderSuccessfulReceipt],
  ["doc-show", (receipt) => String(receipt.evidence)],
  ["init", renderInitReceipt],
  ["schedule-list", renderScheduleReceipt],
  ["schedule-show", renderScheduleReceipt],
  ["schedule-runs", renderScheduleReceipt],
  ["squad-list", renderSquadListReceipt],
]);

const preOutcomeCommandRenderers = new Map<string, ReceiptRenderer>([["runtime-batch", renderRuntimeBatchReceipt]]);

export function renderCliReceipt(receipt: Record<string, unknown>): RenderedCliReceipt {
  const rendered = renderCliReceiptBase(receipt),
    daemonBuild =
      receipt.daemonBuild !== null && typeof receipt.daemonBuild === "object" && !Array.isArray(receipt.daemonBuild)
        ? (receipt.daemonBuild as Record<string, unknown>)
        : null;
  return daemonBuild?.code === "daemon_build_stale" && typeof daemonBuild.message === "string"
    ? { ...rendered, text: `${rendered.text}\nwarning: ${daemonBuild.message}` }
    : rendered;
}

function renderCliReceiptBase(receipt: Record<string, unknown>): RenderedCliReceipt {
  const schemaRenderer = typeof receipt.schema === "string" ? schemaRenderers.get(receipt.schema) : undefined;
  if (schemaRenderer) return { stream: "stdout", text: schemaRenderer(receipt) };
  const preOutcomeRenderer =
    typeof receipt.command === "string" ? preOutcomeCommandRenderers.get(receipt.command) : undefined;
  if (preOutcomeRenderer) return { stream: "stdout", text: preOutcomeRenderer(receipt) };
  if (receipt.ok !== true && !(receipt.command === "migrate-import" && typeof receipt.summary === "string")) {
    const error = humanError(receipt);
    return { stream: "stderr", text: `error code=${error.code} hint=${error.hint}` };
  }
  const commandRenderer = typeof receipt.command === "string" ? commandRenderers.get(receipt.command) : undefined;
  if (commandRenderer) return { stream: "stdout", text: commandRenderer(receipt) };
  if (Array.isArray(receipt.dispatches)) return { stream: "stdout", text: renderDispatches(receipt.dispatches) };
  return { stream: "stdout", text: renderSuccessfulReceipt(receipt) };
}

function renderTaskCreate(receipt: Record<string, unknown>): string {
  if (
    typeof receipt.presetId !== "string" ||
    typeof receipt.profileId !== "string" ||
    typeof receipt.outputShape !== "string" ||
    !Array.isArray(receipt.completionGates)
  )
    return String(receipt.summary ?? "task-create: applied");
  const guidance = renderReceiptGuidance(receipt);
  if (guidance.length === 0) throw new TypeError("Task create receipt has no declared guidance.");
  return [
    String(receipt.summary),
    `preset: ${receipt.presetId}/${receipt.profileId}`,
    `outputShape: ${receipt.outputShape}`,
    `completionGates: ${JSON.stringify(receipt.completionGates)}`,
    ...guidance,
  ].join("\n");
}

function renderTaskShow(receipt: Record<string, unknown>): string {
  const payload = parseEvidence(receipt);
  if (!payload || !isRecord(payload.task)) return renderSuccessfulReceipt(receipt);
  return [`status: ${String(payload.task.status)}`, `graph cursor: ${String(payload.task.currentNode)}`].join("\n");
}

function renderPresetListReceipt(receipt: Record<string, unknown>): string {
  const rows = JSON.parse(String(receipt.evidence)) as Array<Record<string, unknown>>;
  return rows
    .map((row) => {
      const gates = Array.isArray(row.completionGates) ? JSON.stringify(row.completionGates) : "unavailable";
      return [
        `${String(row.id)} — ${String(row.title)} — ${String(row.description)}`,
        `  validity: ${String(row.validity)}`,
        `  defaultProfile: ${String(row.defaultProfile ?? "unavailable")}`,
        `  outputShape: ${String(row.outputShape ?? "unavailable")}`,
        `  completionGates: ${gates}`,
      ].join("\n");
    })
    .join("\n");
}

function renderRuntimeBatchReceipt(receipt: Record<string, unknown>): string {
  const dispatches = Array.isArray(receipt.dispatches) ? receipt.dispatches : [];
  return dispatches.length ? dispatches.map(renderRuntimeBatchRow).join("\n") : "No batch dispatches.";
}

function renderDispatches(dispatches: readonly unknown[]): string {
  return dispatches.length ? dispatches.map(renderDispatchRow).join("\n") : "No dispatches.";
}

function renderScheduleReceipt(receipt: Record<string, unknown>): string {
  return (
    renderScheduleList(receipt) ??
    renderScheduleShow(receipt) ??
    renderScheduleRuns(receipt) ??
    renderSuccessfulReceipt(receipt)
  );
}

function renderSquadListReceipt(receipt: Record<string, unknown>): string {
  const parsed = parseEvidence(receipt);
  if (!parsed || parsed.schema !== "squad-list/v1" || !Array.isArray(parsed.squads))
    return renderSuccessfulReceipt(receipt);
  return parsed.squads.length === 0 ? "No squads." : parsed.squads.map(squadListColumns).join("\n");
}

function parseEvidence(receipt: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof receipt.evidence !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(receipt.evidence);
    return isRecord(parsed) ? parsed : null;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

function squadListColumns(value: unknown): string {
  if (!isRecord(value) || typeof value.id !== "string") throw new TypeError("Squad list row is invalid.");
  if (value.state === "invalid") {
    if (!isRecord(value.error) || typeof value.error.code !== "string" || typeof value.error.hint !== "string")
      throw new TypeError("Degraded Squad list row is missing its structured error.");
    return [value.id, value.state, `${value.error.code}: ${value.error.hint}`].join("\t");
  }
  if (value.validity !== "valid" && value.validity !== "blocked")
    throw new TypeError("Available Squad list row is missing its validity.");
  return [value.id, value.validity, "none"].join("\t");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderInitReceipt(receipt: Record<string, unknown>): string {
  return [
    String(receipt.summary),
    `outcome: ${receipt.outcome ?? "applied"}`,
    ...["created", "updated", "preserved", "drifted"].map((key) => `${key}: ${JSON.stringify(receipt[key] ?? [])}`),
    `commit: ${String(receipt.commit ?? "none")}`,
    `next: ${String(receipt.next ?? "")}`,
  ].join("\n");
}

function renderSuccessfulReceipt(receipt: Record<string, unknown>): string {
  return String(
    contractMigrationDryRunSummary(receipt) ??
      receipt.summary ??
      `${receipt.command ?? "command"}: ${receipt.outcome ?? "applied"}`,
  );
}
