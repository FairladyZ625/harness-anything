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

type ReceiptRenderer = (receipt: Record<string, unknown>, explainRequestRefs?: readonly string[]) => string;

const schemaRenderers = new Map<string, ReceiptRenderer>([
  [
    "entity-action-explanation/v1",
    (receipt, explainRequestRefs) =>
      renderEntityActionExplanation(receipt as unknown as EntityActionExplanationRenderInput, explainRequestRefs),
  ],
]);

const commandRenderers = new Map<string, ReceiptRenderer>([
  ["task-create", renderTaskCreate],
  ["task-show", renderTaskShow],
  ["decision-propose", renderDecisionPropose],
  ["preset-list", renderPresetListReceipt],
  ["migrate-import", renderSuccessfulReceipt],
  ["task-contract-migrate", renderSuccessfulReceipt],
  ["doc-show", (receipt) => String(receipt.evidence)],
  ["init", renderInitReceipt],
  ["settings-read", renderSettingsRead],
  ["schedule-list", renderScheduleReceipt],
  ["schedule-show", renderScheduleReceipt],
  ["schedule-runs", renderScheduleReceipt],
  ["squad-list", renderSquadListReceipt],
  ["squad-status", renderSquadStatusReceipt],
]);

const preOutcomeCommandRenderers = new Map<string, ReceiptRenderer>([["runtime-batch", renderRuntimeBatchReceipt]]);

export function renderCliReceipt(
  receipt: Record<string, unknown>,
  explainRequestRefs?: readonly string[],
): RenderedCliReceipt {
  const base = renderCliReceiptBase(receipt, explainRequestRefs),
    rendered =
      receipt.status === "accepted_durable"
        ? {
            ...base,
            text: [
              `${base.text}\n${[
                "acceptance: accepted_durable",
                gitFacetText(receipt.git),
                `projection: ${isRecord(receipt.projection) ? String(receipt.projection.state) : "pending"}`,
                ...(isRecord(receipt.wait) ? [`wait: ${String(receipt.wait.state)}`] : []),
              ].join("; ")}`,
              ...renderReceiptNext(receipt.next),
            ].join("\n"),
          }
        : base.stream === "stderr"
          ? { ...base, text: [base.text, ...renderReceiptNext(receipt.next, base.text)].join("\n") }
          : base,
    daemonBuild =
      receipt.daemonBuild !== null && typeof receipt.daemonBuild === "object" && !Array.isArray(receipt.daemonBuild)
        ? (receipt.daemonBuild as Record<string, unknown>)
        : null,
    warnings = [
      ...(daemonBuild?.code === "daemon_build_stale" && typeof daemonBuild.message === "string"
        ? [daemonBuild.message]
        : []),
      ...(Array.isArray(receipt.warnings)
        ? receipt.warnings.filter((entry): entry is string => nonEmptyText(entry) !== null)
        : []),
    ];
  return warnings.length
    ? { ...rendered, text: `${rendered.text}\n${warnings.map((warning) => `warning: ${warning}`).join("\n")}` }
    : rendered;
}

function renderCliReceiptBase(
  receipt: Record<string, unknown>,
  explainRequestRefs?: readonly string[],
): RenderedCliReceipt {
  if (receipt.schema === "squad-control-result/v1")
    return { stream: receipt.ok === true ? "stdout" : "stderr", text: String(receipt.summary) };
  const schemaRenderer = typeof receipt.schema === "string" ? schemaRenderers.get(receipt.schema) : undefined;
  if (schemaRenderer) return { stream: "stdout", text: schemaRenderer(receipt, explainRequestRefs) };
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
  const gates = Array.isArray(payload.task.completionGateIds) ? payload.task.completionGateIds : [],
    blocker = isRecord(payload.completionBlocker) ? payload.completionBlocker : null;
  return [
    `status: ${String(payload.task.status)}`,
    `graph cursor: ${String(payload.task.currentNode)}`,
    `completion gates: ${
      [...gates, ...(typeof blocker?.gate === "string" ? [`${blocker.gate} (${String(blocker.code)})`] : [])].join(
        ", ",
      ) || "none"
    }`,
    `packageDisposition: ${String(payload.task.packageDisposition ?? "active")}`,
    ...(typeof payload.returnBudget === "number"
      ? [`returnBudget=${String(payload.returnBudget)} (${String(payload.returnBudgetSource)})`]
      : []),
  ].join("\n");
}

function renderSettingsRead(receipt: Record<string, unknown>): string {
  const lastChanged = receipt.lastChanged;
  return [
    renderSuccessfulReceipt(receipt),
    lastChanged === "initial"
      ? "lastChanged=initial"
      : isRecord(lastChanged)
        ? `lastChanged=${String(lastChanged.occurredAt)} by=${String(lastChanged.actor)} revision=${String(lastChanged.revision)}`
        : "lastChanged=unavailable",
  ].join("\n");
}

function renderDecisionPropose(receipt: Record<string, unknown>): string {
  const payload = parseEvidence(receipt),
    summary = renderSuccessfulReceipt(receipt);
  return typeof payload?.decisionId === "string"
    ? `${summary}\nnext: ha explain decision/${payload.decisionId}`
    : summary;
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

function renderSquadStatusReceipt(receipt: Record<string, unknown>): string {
  const leaders = Array.isArray(receipt.leaders) ? receipt.leaders : [],
    workers = Array.isArray(receipt.workers) ? receipt.workers : [];
  return [
    String(receipt.summary ?? "squad-status"),
    ...leaders.map((turn, index) => squadAttemptLine("leader", index + 1, turn)),
    ...workers.map((attempt, index) => squadAttemptLine("worker", index + 1, attempt)),
  ].join("\n");
}

function squadAttemptLine(kind: string, index: number, value: unknown): string {
  if (!isRecord(value)) throw new TypeError(`Squad ${kind} metrics are invalid.`);
  const usage = isRecord(value.tokenUsage) ? value.tokenUsage : {};
  return (
    `${kind} ${String(value.turnId ?? value.attemptId ?? index)}: status=${String(value.status ?? "unknown")}` +
    ` tokens=${String(usage.input ?? 0)}in/${String(usage.output ?? 0)}out` +
    ` tools=${String(value.toolCallCount ?? 0)} compacted=${String(value.compacted ?? false)}`
  );
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
  return value.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The git facet is the daemon's ledger-to-git publication channel (the harness outbox commits),
// not the caller's own working tree; it lags the durable SQLite acceptance, so "pending" here
// names only that publication queue.
function gitFacetText(git: unknown): string {
  if (!isRecord(git)) return "git(harness-outbox): pending";
  const commitSha = typeof git.commitSha === "string" && /^[0-9a-f]{40}$/u.test(git.commitSha) ? git.commitSha : null;
  return commitSha === null
    ? `git(harness-outbox): ${String(git.state ?? "pending")}`
    : `git(harness-outbox): committed ${commitSha.slice(0, 7)}`;
}

// Lifecycle receipts carry { command, reason }; completion guidance (submit rejections, completion
// blockers) carries the kernel's CompletionNext { action, reason, ... }.
function renderReceiptNext(next: unknown, renderedText = ""): readonly string[] {
  if (!Array.isArray(next)) return [];
  return next.flatMap((entry) => {
    const command = isRecord(entry) ? (nonEmptyText(entry.command) ?? nonEmptyText(entry.action)) : null;
    if (command === null) throw new TypeError("Receipt next entries must carry a command or action.");
    if (renderedText.includes(command)) return [];
    const reason = isRecord(entry) ? nonEmptyText(entry.reason) : null;
    return [reason === null || renderedText.includes(reason) ? `next: ${command}` : `next: ${command} (${reason})`];
  });
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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
