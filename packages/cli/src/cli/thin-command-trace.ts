import type { SafePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { accepted, nonEmpty, readFlags, rejected } from "./thin-command-flags.ts";
import type { ProtocolCommand, ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

/** `ha trace <path> [--limit <n>] [--json]`; the path may follow the flags. The daemon normalizes and validates it. */
export function parseTrace(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const rest = args.slice(1),
    descriptorInputs = inputs.get(route.id)?.inputs ?? [];
  let pathIndex = -1;
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]!;
    if (descriptorInputs.some((input) => input.kind === "single" && input.name === token)) index++;
    else if (!token.startsWith("--")) {
      pathIndex = index;
      break;
    }
  }
  const rawPath = pathIndex === -1 ? undefined : rest[pathIndex];
  if (!nonEmpty(rawPath))
    return rejected("missing_field", "Use ha trace <repository-relative-path> [--limit <1..200>].", json);
  const flags = readFlags(route.id, [...rest.slice(0, pathIndex), ...rest.slice(pathIndex + 1)], inputs);
  if (!flags.ok) return rejected(flags.code, flags.nextAction, json);
  const limit = flags.one.get("--limit");
  return accepted(
    rootDir,
    repoId,
    json,
    { kind: "trace", path: rawPath, ...(limit === undefined ? {} : { limit: Number(limit) }) },
    route.method,
  );
}

interface TracePayload {
  readonly schema: "file-trace-read/v1";
  readonly path: string;
  readonly projectionCut?: { readonly sourceRevision?: number };
  readonly git?: { readonly availability?: string; readonly reason?: string; readonly message?: string };
  readonly touchHistory?: readonly {
    readonly shortSha?: string;
    readonly prNumber?: number | null;
    readonly taskId?: string | null;
    readonly taskStatus?: string | null;
    readonly summary?: string;
  }[];
  readonly decisions?: readonly {
    readonly decisionId?: string;
    readonly title?: string;
    readonly state?: string;
    readonly viaTaskIds?: readonly string[];
    readonly viaModulePrefix?: string | null;
    readonly chosen?: readonly { readonly id?: string; readonly summary?: string }[];
    readonly rejected?: readonly { readonly id?: string; readonly summary?: string; readonly whyNot?: string }[];
  }[];
  readonly facts?: readonly {
    readonly factId?: string;
    readonly domainType?: string;
    readonly summary?: string;
    readonly matchReason?: string;
    readonly observedCommit?: string | null;
  }[];
  readonly activeTasks?: readonly {
    readonly taskId?: string;
    readonly title?: string | null;
    readonly status?: string | null;
    readonly branch?: string;
    readonly commits?: number;
    readonly matchReason?: "branch_diff" | "worktree_dirty";
  }[];
}

function tracePayload(receipt: Record<string, unknown>): TracePayload | null {
  const evidence = receipt.evidence;
  if (typeof evidence !== "string" || !evidence.trimStart().startsWith("{")) return null;
  const parsed = JSON.parse(evidence) as { readonly schema?: unknown };
  return parsed.schema === "file-trace-read/v1" ? (parsed as TracePayload) : null;
}

function renderTraceTouches(touches: NonNullable<TracePayload["touchHistory"]>): string[] {
  const lines = ["", `[1] Touch History (${touches.length} commits)`];
  if (touches.length === 0) return [...lines, "  (no recorded history)"];
  for (const touch of touches)
    lines.push(
      `  • ${touch.prNumber ? `PR #${touch.prNumber}` : (touch.shortSha ?? "?")} (${touch.shortSha ?? "?"}) -> ` +
        `${touch.taskId ?? "(no task)"}${touch.taskStatus ? ` [${touch.taskStatus}]` : ""}: ${touch.summary ?? ""}`,
    );
  return lines;
}

function renderTraceDecisions(decisions: NonNullable<TracePayload["decisions"]>): string[] {
  const lines = ["", `[2] Governing Decisions & Redlines (${decisions.length})`];
  if (decisions.length === 0) return [...lines, "  (none)"];
  for (const decision of decisions) {
    const via = [
      ...(decision.viaTaskIds?.length ? [`via ${decision.viaTaskIds.join(", ")}`] : []),
      ...(decision.viaModulePrefix ? [`appliesTo ${decision.viaModulePrefix}`] : []),
    ];
    lines.push(
      `  • ${decision.decisionId ?? "?"} [${decision.state ?? "?"}]: ${decision.title ?? ""}${via.length ? ` (${via.join("; ")})` : ""}`,
    );
    for (const chosen of decision.chosen ?? []) lines.push(`    ✓ ${chosen.id ?? "CH"}: ${chosen.summary ?? ""}`);
    for (const rejectedOption of decision.rejected ?? []) {
      lines.push(`    ✗ ${rejectedOption.id ?? "RJ"} (PROHIBITED): ${rejectedOption.summary ?? ""}`);
      if (rejectedOption.whyNot) lines.push(`      Why Not: ${rejectedOption.whyNot}`);
    }
  }
  return lines;
}

function renderTraceFacts(facts: NonNullable<TracePayload["facts"]>): string[] {
  const lines = ["", `[3] Anchored Facts (${facts.length})`];
  if (facts.length === 0) return [...lines, "  (none)"];
  for (const fact of facts)
    lines.push(
      `  • ${fact.factId ?? "?"} [${fact.domainType ?? "general"}; ${fact.matchReason ?? "?"}${
        fact.observedCommit ? ` @ ${fact.observedCommit.slice(0, 8)}` : ""
      }]: ${fact.summary ?? ""}`,
    );
  return lines;
}

function renderTraceCollisions(active: NonNullable<TracePayload["activeTasks"]>): string[] {
  const lines = ["", `[4] Active Branch Collisions (${active.length})`];
  if (active.length === 0) return [...lines, "  (none)"];
  for (const task of active)
    lines.push(
      `  • ${task.taskId ?? "?"} [${task.status ?? "unknown"}] ${task.branch ?? ""} ` +
        `(${String(task.commits ?? 0)} unmerged commits${task.matchReason === "worktree_dirty" ? ", uncommitted worktree changes" : ""}): ${task.title ?? ""}`,
    );
  return lines;
}

/** Four sections, redlines spelled out: rejected options carry their whyNot verbatim. */
export function renderTraceReceipt(receipt: Record<string, unknown>): string | null {
  const data = tracePayload(receipt);
  if (data === null) return null;
  const lines = [`=== Causal Trace: ${data.path} (cut: rev ${String(data.projectionCut?.sourceRevision ?? "?")}) ===`];
  if (data.git?.availability === "unavailable")
    lines.push(`! Git history unavailable (${data.git.reason ?? "unknown"}): ${data.git.message ?? ""}`);
  lines.push(
    ...renderTraceTouches(data.touchHistory ?? []),
    ...renderTraceDecisions(data.decisions ?? []),
    ...renderTraceFacts(data.facts ?? []),
    ...renderTraceCollisions(data.activeTasks ?? []),
  );
  return lines.join("\n");
}
