import type { DaemonGuiReadResultMap } from "@harness-anything/daemon/protocol";
import { contractMigrationDryRunSummary, renderDispatchRow, renderRuntimeBatchRow } from "../cli-render.ts";
import {
  renderEntityActionExplanation,
  type EntityActionExplanationRenderInput,
} from "./entity-action-explain-render.ts";
import { renderCausalGraph } from "./graph-render.ts";
import { consumeKnownError } from "../daemon/client.ts";
import { humanError, renderReceiptGuidance } from "./guidance-plane.ts";
import {
  renderScheduleList,
  renderScheduleReckon,
  renderScheduleRuns,
  renderScheduleShow,
} from "./thin-command-schedule.ts";

export interface RenderedCliReceipt {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

type ReceiptRenderer = (receipt: Record<string, unknown>, explainRequestRefs?: readonly string[]) => string;

const schemaRenderers = new Map<string, ReceiptRenderer>([
  ["daemon.ci-observatory/v1", renderCiObservatory],
  [
    "entity-action-explanation/v1",
    (receipt, explainRequestRefs) =>
      renderEntityActionExplanation(receipt as unknown as EntityActionExplanationRenderInput, explainRequestRefs),
  ],
]);

const commandRenderers = new Map<string, ReceiptRenderer>([
  ["task-create", renderTaskCreate],
  ["task-adjudicate", renderAdjudication],
  ["task-dispatch-review", renderReviewDispatches],
  ["task-show", renderTaskShow],
  ["decision-propose", renderDecisionPropose],
  ["preset-list", renderPresetListReceipt],
  ["migrate-import", renderSuccessfulReceipt],
  ["task-contract-migrate", renderSuccessfulReceipt],
  ["doc-show", (receipt) => String(receipt.evidence)],
  ["init", renderInitReceipt],
  ["settings-read", renderSettingsRead],
  ["schedule-list", renderScheduleReceipt],
  ["schedule-reckon", renderScheduleReceipt],
  ["schedule-show", renderScheduleReceipt],
  ["schedule-runs", renderScheduleReceipt],
  ["squad-list", renderSquadListReceipt],
  ["squad-status", renderSquadStatusReceipt],
  ["event-list", renderEventListReceipt],
  ["event-show", renderEventShowReceipt],
  ["graph", (receipt) => renderCausalGraph(receipt) ?? renderSuccessfulReceipt(receipt)],
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
          : receipt.status === "settled_no_write"
            ? { ...base, text: `${base.text}\nacceptance: settled_no_write` }
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
  if (receipt.pending === true && typeof receipt.verificationUri === "string" && typeof receipt.userCode === "string")
    return {
      stream: "stdout",
      text: `Open ${receipt.verificationUri}\nEnter code: ${receipt.userCode}\nExpires: ${new Date(Number(receipt.expiresAt)).toISOString()}\nWaiting for browser approval…`,
    };
  if (typeof receipt.authenticated === "boolean")
    return {
      stream: "stdout",
      text: receipt.authenticated
        ? `Signed in as ${String(receipt.personId)}\nSession expires: ${new Date(Number(receipt.expiresAt)).toISOString()}`
        : "Signed out.",
    };
  const commandRenderer = typeof receipt.command === "string" ? commandRenderers.get(receipt.command) : undefined;
  if (commandRenderer) return { stream: "stdout", text: commandRenderer(receipt) };
  if (Array.isArray(receipt.dispatches)) return { stream: "stdout", text: renderDispatches(receipt.dispatches) };
  return { stream: "stdout", text: renderSuccessfulReceipt(receipt) };
}

function renderAdjudication(receipt: Record<string, unknown>): string {
  const steps = Array.isArray(receipt.steps) ? receipt.steps.filter(isRecord) : [];
  return [
    renderSuccessfulReceipt(receipt),
    ...(typeof receipt.reviewerId === "string"
      ? [`reviewer: ${receipt.reviewerId} (source: ${String(receipt.reviewerSource)})`]
      : []),
    ...steps
      .filter((step) => step.outcome === "failed" || step.outcome === "op_rejected")
      .map((step) => `review dispatch failed: ${humanError(step).hint}`),
  ].join("\n");
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
    // Optional on the write-receipt schema: legacy receipts predate the field and render no line.
    ...(typeof receipt.expectedVersion === "number"
      ? [
          `expected-version: ${String(receipt.expectedVersion)} (pass as --expected-version to assign/unassign/transition)`,
        ]
      : []),
    `completion gates: ${
      [...gates, ...(typeof blocker?.gate === "string" ? [`${blocker.gate} (${String(blocker.code)})`] : [])].join(
        ", ",
      ) || "none"
    }`,
    `packageDisposition: ${String(payload.task.packageDisposition ?? "active")}`,
    ...(isRecord(payload.workspace) ? [workspaceLine(payload.workspace, payload.worktreeSetup)] : []),
    ...(typeof payload.returnBudget === "number"
      ? [`returnBudget=${String(payload.returnBudget)} (${String(payload.returnBudgetSource)})`]
      : []),
  ].join("\n");
}

/** dec_8B3FCCD256CAC5B0BF3CCEDE58 CH4: one line tells where every task works. */
function workspaceLine(workspace: Record<string, unknown>, setup: unknown): string {
  if (workspace.kind !== "worktree")
    return `workspace: ${String(workspace.path)} (task package; this task does not change repository files)`;
  const declared = isRecord(setup) && Array.isArray(setup.declared) ? setup.declared.map(String) : [],
    succeeded = isRecord(setup) && Array.isArray(setup.succeeded) ? setup.succeeded.map(String) : null,
    rows =
      succeeded === null
        ? declared.length
          ? [`${declared.join("; ")} (unknown: no checkout on this node)`]
          : []
        : [
            ...declared.map((step) =>
              succeeded.includes(step) ? `${step} (done)` : `${step} (pending, runs at next start)`,
            ),
            ...succeeded.filter((step) => !declared.includes(step)).map((step) => `${step} (done)`),
          ],
    steps = rows.length ? rows.join("; ") : "none";
  return (
    `workspace: ${String(workspace.path)} (worktree on branch ${String(workspace.branch)}, ` +
    `${String(workspace.state)}; setup: ${steps}; managed by Harness, no command needed)`
  );
}

function renderSettingsRead(receipt: Record<string, unknown>): string {
  const lastChanged = receipt.lastChanged,
    worktree = isRecord(receipt.settings) && isRecord(receipt.settings.worktree) ? receipt.settings.worktree : null,
    setup = Array.isArray(worktree?.setup) ? worktree.setup.map(String) : [];
  return [
    renderSuccessfulReceipt(receipt),
    `worktree.setup: ${setup.length ? setup.join("; ") : "none"}`,
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

/** Review-dispatch steps carry the reviewed task and an outcome, never a dispatch status. */
function renderReviewDispatches(receipt: Record<string, unknown>): string {
  const steps = (Array.isArray(receipt.dispatches) ? receipt.dispatches : []) as readonly Record<string, unknown>[];
  return [
    String(receipt.summary),
    ...steps.map((step) =>
      [step.taskId, step.outcome, step.dispatchId, step.runtimeSessionId, step.error]
        .filter((cell) => cell !== undefined)
        .map(String)
        .join("\t"),
    ),
  ].join("\n");
}

function renderDispatches(dispatches: readonly unknown[]): string {
  return dispatches.length ? dispatches.map(renderDispatchRow).join("\n") : "No dispatches.";
}

function renderScheduleReceipt(receipt: Record<string, unknown>): string {
  return (
    renderScheduleList(receipt) ??
    renderScheduleReckon(receipt) ??
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
  // The daemon receipt derives every attempt status from one source (squadAttemptStatus);
  // a missing status here is a broken contract, not a display fallback.
  if (typeof value.status !== "string") throw new TypeError(`Squad ${kind} status is missing.`);
  const usage = isRecord(value.tokenUsage) ? value.tokenUsage : {},
    rejection = typeof value.rejection === "string" && value.rejection !== "" ? ` rejection=${value.rejection}` : "";
  return (
    `${kind} ${String(value.turnId ?? value.attemptId ?? index)}: status=${value.status}` +
    ` tokens=${String(usage.input ?? 0)}in/${String(usage.output ?? 0)}out` +
    ` tools=${String(value.toolCallCount ?? 0)} compacted=${String(value.compacted ?? false)}` +
    rejection
  );
}

function renderEventListReceipt(receipt: Record<string, unknown>): string {
  const payload = parseEvidence(receipt);
  if (!payload || payload.schema !== "event-list/v1" || !Array.isArray(payload.rows))
    return renderSuccessfulReceipt(receipt);
  const lines = payload.rows.map((row) => {
      if (!isRecord(row) || !isRecord(row.actor)) throw new TypeError("Event list row is invalid.");
      const principal = row.actor.principal;
      if (!isRecord(principal)) throw new TypeError("Event principal is invalid.");
      const actor =
        typeof row.actor.executorId === "string"
          ? row.actor.executorId
          : principal.kind === "machine"
            ? `machine:${principal.nodeId}:${principal.subject}`
            : principal.personId;
      return [row.revision, row.occurredAt, row.type, row.opId, actor].map((value) => String(value ?? "")).join(" | ");
    }),
    nextCursor = isRecord(payload.page) && typeof payload.page.nextCursor === "string" ? payload.page.nextCursor : null;
  return [
    ...(lines.length ? lines : ["No events."]),
    ...(nextCursor === null ? [] : [`more: use --cursor ${nextCursor}`]),
  ].join("\n");
}

function renderEventShowReceipt(receipt: Record<string, unknown>): string {
  const payload = parseEvidence(receipt);
  return payload?.event !== undefined ? JSON.stringify(payload.event, null, 2) : renderSuccessfulReceipt(receipt);
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

/** Presentation only: verdicts, coverage, recoveries and statistics belong to the shared daemon DTO. */
function renderCiObservatory(receipt: Record<string, unknown>): string {
  const ci = receipt as unknown as DaemonGuiReadResultMap["repo.ci.observatory.read"];
  const lines = [
    `CI observations sourceRevision=${ci.sourceRevision} window=${ci.window} status=${ci.status} statistics=${ci.statisticsAvailability}`,
  ];
  if (ci.importer) {
    const { scheduleId, activeRun, lastRun, progress } = ci.importer;
    lines.push(`importer ${scheduleId}`);
    lines.push(
      activeRun
        ? `owner ${activeRun.nodeId} occurrence=${activeRun.occurrenceId} fence=${activeRun.claimFence}`
        : "owner idle",
    );
    if (lastRun)
      lines.push(
        `last occurrence=${lastRun.occurrenceId} node=${lastRun.nodeId} outcome=${lastRun.outcome} detail=${lastRun.detail ?? "unavailable"}`,
      );
    if (progress) {
      lines.push(
        `scan workflow=${progress.workflow} pass=${progress.scanPass} page=${progress.nextPage} error=${progress.error ?? "none"}`,
      );
      for (const target of progress.pending) lines.push(`pending artifact ${target.runId}.${target.attempt}`);
      for (const target of progress.unavailable)
        lines.push(`unavailable artifact ${target.runId}.${target.attempt}: ${target.reason}`);
    }
  } else lines.push("importer unavailable at this cut");
  for (const id of ci.missingDetails) lines.push(`missing detail ${id}`);
  if (ci.statisticsAvailability === "pending")
    lines.push("Required evidence is missing; totals and quantiles are unavailable.");
  for (const test of ci.tests) {
    lines.push(
      `${test.file} ${test.name}: n=${test.n} p50=${test.p50Ms ?? "unavailable"}ms p95=${test.p95Ms ?? "unavailable"}ms rerunRecoveryRate=${test.rerunRecoveryRate ?? "unavailable"} (${test.recoveredFamilies}/${test.families}) excluded=${test.excludedFamilies}`,
    );
    for (const attempt of test.notRerunAttempts)
      lines.push(`  not-rerun ${attempt.familyKey} attempt=${attempt.attempt}`);
  }
  for (const fact of ci.recoveries) {
    lines.push(
      `recovery ${fact.jobKey} ${fact.testKey}: attempt ${fact.from.attempt} -> ${fact.to.attempt} final=${fact.finalStatus} complete=${fact.complete}`,
    );
    lines.push(`  ${fact.from.eventId} -> ${fact.to.eventId}`);
  }
  if (ci.runs.length === 0) lines.push("No CI observations at this cut.");
  for (const run of ci.runs) lines.push(...renderCiRun(run));
  return lines.join("\n");
}

function renderCiRun(run: DaemonGuiReadResultMap["repo.ci.observatory.read"]["runs"][number]): readonly string[] {
  const lines = [
    `${run.eventId} ${run.job} ${run.runId} ${run.sha}: pass=${run.pass ?? "unknown"} scope=${run.scope} measurement=${run.measurementCoverage.status} tests=${run.testCount ?? "unknown"} detail=${run.detailAvailability}`,
  ];
  if (run.measurementCoverage.missingReason) lines.push(`  ${run.measurementCoverage.missingReason}`);
  for (const test of run.failedTests) {
    const at = test.failureLocation;
    lines.push(
      `  failed ${test.name}: ${test.failureSummary ?? "diagnostic unavailable"}${test.truncated ? " (summary truncated)" : ""}`,
    );
    lines.push(
      `    ${at ? `${at.file}:${at.line}:${at.column}` : `${test.file}:${test.declarationLocation.line ?? "?"}:${test.declarationLocation.column ?? "?"}`}`,
    );
  }
  for (const file of run.fileOutcomes)
    lines.push(
      `  file ${file.file}: ${file.outcome} ${file.elapsedMs ?? "?"}/${file.limitMs ?? "?"}ms ${file.reason} ${file.stallSummary ?? ""}`,
    );
  if (run.failedTests.length === 0)
    lines.push("  No failed test identities observed; this does not establish a passing workflow.");
  if (run.detail) lines.push(JSON.stringify(run.detail, null, 2));
  return lines;
}
