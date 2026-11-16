import type { SafePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { accepted, nonEmpty, readFlags, rejected } from "./thin-command-flags.ts";
import type { ProtocolCommand, ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

type TouchEntry = {
  readonly commitSha?: string;
  readonly shortSha?: string;
  readonly prNumber?: number | null;
  readonly taskId?: string | null;
  readonly taskTitle?: string | null;
  readonly taskStatus?: string | null;
  readonly summary?: string;
};

type DecisionEntry = {
  readonly decisionId?: string;
  readonly title?: string;
  readonly state?: string;
  readonly summary?: string;
  readonly viaTaskIds?: readonly string[];
  readonly viaModulePrefix?: string | null;
  readonly chosen?: readonly { readonly id?: string; readonly summary?: string }[];
  readonly rejected?: readonly {
    readonly id?: string;
    readonly summary?: string;
    readonly whyNot?: string | null;
  }[];
};

type FactEntry = {
  readonly factId?: string;
  readonly domainType?: string;
  readonly subjectRef?: string;
  readonly summary?: string;
  readonly loadBearing?: boolean;
  readonly observedCommit?: string | null;
  readonly recordedByTaskId?: string | null;
};

type ActiveTaskEntry = {
  readonly taskId?: string;
  readonly title?: string;
  readonly status?: string;
  readonly matchReason?: string;
};

interface TracePayload {
  readonly schema: "file-trace-read/v1";
  readonly path: string;
  readonly projectionCut?: {
    readonly status?: string;
    readonly watermark?: number;
    readonly sourceRevision?: number;
  };
  readonly touchHistory?: readonly TouchEntry[];
  readonly decisions?: readonly DecisionEntry[];
  readonly facts?: readonly FactEntry[];
  readonly activeTasks?: readonly ActiveTaskEntry[];
}

function normalizeCliTracePath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0 || trimmed.includes("\0")) return null;
  const slashed = trimmed.replaceAll("\\", "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/u.test(slashed)) return null;
  let stripped = slashed;
  while (stripped.startsWith("./")) stripped = stripped.slice(2);
  const segments = stripped.split("/");
  if (segments.length === 0 || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return segments.join("/");
}

function splitTraceArgv(
  args: readonly string[],
  singleFlags: readonly string[],
): {
  readonly rawPath: string | undefined;
  readonly flagTokens: readonly string[];
} {
  const rest = args.slice(1);
  if (rest.length === 0) return { rawPath: undefined, flagTokens: [] };
  const first = rest[0]!;
  if (singleFlags.includes(first) && rest.length >= 3) {
    return { rawPath: rest[2], flagTokens: [rest[0]!, rest[1]!, ...rest.slice(3)] };
  }
  if (singleFlags.some((flag) => first.startsWith(`${flag}=`))) {
    return { rawPath: rest[1], flagTokens: [rest[0]!, ...rest.slice(2)] };
  }
  if (first.startsWith("-")) {
    return { rawPath: undefined, flagTokens: rest };
  }
  return { rawPath: first, flagTokens: rest.slice(1) };
}

export function parseTrace(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const routeInputs = route.inputs as readonly { readonly kind: string; readonly name: string }[];
  const singleFlags = routeInputs.filter((input) => input.kind === "single").map((input) => input.name);
  const { rawPath, flagTokens } = splitTraceArgv(args, singleFlags);
  const flags = readFlags(route.id, flagTokens, inputs);
  if (!flags.ok) return rejected(flags.code, flags.nextAction, json);
  if (rawPath === undefined || !nonEmpty(rawPath)) {
    return rejected(
      "invalid_trace_path",
      "Use ha trace <path> [--limit <1..200>] [--json] with a repository-relative path.",
      json,
    );
  }
  const normalizedPath = normalizeCliTracePath(rawPath);
  if (normalizedPath === null) {
    return rejected(
      "invalid_trace_path",
      "Trace path must be a clean repository-relative path within the workspace.",
      json,
    );
  }
  const rawMaxCommits = flags.one.get("--limit");
  return accepted(
    rootDir,
    repoId,
    json,
    {
      kind: "trace",
      path: normalizedPath,
      ...(rawMaxCommits === undefined ? {} : { limit: Number(rawMaxCommits) }),
    },
    route.method,
  );
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function renderTouchHistoryLines(touches: readonly TouchEntry[], emptyLabel: string): readonly string[] {
  const uniqueTaskIds: string[] = [];
  for (const entry of touches) {
    if (entry.taskId && !uniqueTaskIds.includes(entry.taskId)) uniqueTaskIds.push(entry.taskId);
  }
  const lines = [`[1] Touch History (${touches.length} commits, ${uniqueTaskIds.length} tasks)`];
  if (touches.length === 0) {
    lines.push(`  ${emptyLabel}`);
    return lines;
  }
  for (const touch of touches) {
    const prText = touch.prNumber ? `PR #${touch.prNumber}` : (touch.shortSha ?? touch.commitSha ?? "?");
    const taskText = touch.taskId ?? "(no task id)";
    const statusText = touch.taskStatus ? ` [${touch.taskStatus}]` : "";
    lines.push(`  • ${prText} (${touch.shortSha ?? "?"}) -> ${taskText}${statusText}: ${touch.summary ?? ""}`);
  }
  return lines;
}

function renderDecisionsLines(decisions: readonly DecisionEntry[]): readonly string[] {
  const lines = [`[2] Governing Decisions & Redlines (${decisions.length})`];
  if (decisions.length === 0) {
    lines.push("  (none)");
    return lines;
  }
  for (const decision of decisions) {
    const viaParts: string[] = [];
    if (decision.viaTaskIds && decision.viaTaskIds.length > 0) viaParts.push(`via ${decision.viaTaskIds.join(", ")}`);
    if (decision.viaModulePrefix) viaParts.push(`appliesTo ${decision.viaModulePrefix}`);
    const viaSuffix = viaParts.length > 0 ? ` (${viaParts.join("; ")})` : "";
    lines.push(`  • ${decision.decisionId ?? "?"} [${decision.state ?? "?"}]: ${decision.title ?? ""}${viaSuffix}`);
    for (const chosen of decision.chosen ?? []) lines.push(`    ✓ ${chosen.id ?? "CH"}: ${chosen.summary ?? ""}`);
    for (const rejectedEntry of decision.rejected ?? []) {
      lines.push(`    ✗ ${rejectedEntry.id ?? "RJ"} (PROHIBITED): ${rejectedEntry.summary ?? ""}`);
      if (rejectedEntry.whyNot) lines.push(`      Why Not: ${rejectedEntry.whyNot}`);
    }
  }
  return lines;
}

function renderFactsLines(facts: readonly FactEntry[]): readonly string[] {
  const lines = [`[3] Load-Bearing Facts (${facts.length})`];
  if (facts.length === 0) {
    lines.push("  (none)");
    return lines;
  }
  for (const fact of facts) {
    const commitPart = fact.observedCommit ? ` @ ${fact.observedCommit.slice(0, 8)}` : "";
    const taskPart = fact.recordedByTaskId ? ` by ${fact.recordedByTaskId}` : "";
    lines.push(
      `  • ${fact.factId ?? "?"} [${fact.domainType ?? "general"}${commitPart}${taskPart}]: ${fact.summary ?? ""}`,
    );
  }
  return lines;
}

function renderActiveTasksLines(activeTasks: readonly ActiveTaskEntry[]): readonly string[] {
  const lines = [`[4] Active Worktree Radar (${activeTasks.length} concurrent tasks)`];
  if (activeTasks.length === 0) {
    lines.push("  (none)");
    return lines;
  }
  for (const active of activeTasks) {
    lines.push(
      `  • ${active.taskId ?? "?"} [${active.status ?? "?"}] (${active.matchReason ?? "?"}): ${active.title ?? ""}`,
    );
  }
  return lines;
}

export function renderTraceReceipt(receipt: Record<string, unknown>): string | null {
  const payload: unknown =
    typeof receipt.evidence === "string" && receipt.evidence.trimStart().startsWith("{")
      ? JSON.parse(receipt.evidence)
      : receipt;
  const obj = asObject(payload);
  if (!obj || obj.schema !== "file-trace-read/v1") return null;
  const data = obj as unknown as TracePayload;
  const revision = data.projectionCut?.sourceRevision ?? "?";
  const touches = data.touchHistory ?? [];
  const decisions = data.decisions ?? [];
  const facts = data.facts ?? [];
  const activeTasks = data.activeTasks ?? [];
  const noHistory = touches.length === 0 && decisions.length === 0 && facts.length === 0 && activeTasks.length === 0;
  return [
    `=== Causal Trace: ${data.path} (cut: rev ${String(revision)}) ===`,
    "",
    ...renderTouchHistoryLines(touches, noHistory ? "(no recorded history)" : "(none)"),
    "",
    ...renderDecisionsLines(decisions),
    "",
    ...renderFactsLines(facts),
    "",
    ...renderActiveTasksLines(activeTasks),
  ].join("\n");
}
