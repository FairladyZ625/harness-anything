import {
  attentionScore,
  compareAttention,
  type AgendaAttentionKind,
  type AgendaAttentionRegion,
} from "./agenda-attention.ts";
import type {
  AgendaAnsweredRow,
  AgendaAwaitsRow,
  AgendaDecisionRow,
  AgendaExecutionRow,
  AgendaTaskRow,
  DaemonAgendaResult,
} from "./protocol/daemon-protocol.contract.ts";

interface AttentionSourceRow {
  readonly taskId: string;
  readonly updatedAt: string;
  readonly work: { readonly taskId: string; readonly title: string } | null;
  readonly downstreamBlocked: number;
  readonly snapshot: {
    readonly task: {
      readonly pinned: boolean;
      readonly metadata?: { readonly riskTier?: "low" | "medium" | "high" | null };
    } | null;
  };
}

export function buildAttentionItems(input: {
  readonly now: string;
  readonly awaitingYou: readonly AgendaAwaitsRow[];
  readonly answeredForYou: readonly AgendaAnsweredRow[];
  readonly awaitingRework: readonly AgendaTaskRow[];
  readonly awaitingAdjudication: readonly AgendaExecutionRow[];
  readonly awaitingDecision: readonly AgendaDecisionRow[];
  readonly waitingOnOthers: readonly AgendaTaskRow[];
  readonly stalled: readonly AgendaTaskRow[];
  readonly sourceRows: readonly AttentionSourceRow[];
}): DaemonAgendaResult["attentionItems"] {
  const sources = new Map<string, AttentionSourceRow>(input.sourceRows.map((row) => [`task/${row.taskId}`, row])),
    taskSource = (taskId: string) => sources.get(`task/${taskId}`),
    add = (
      ref: string,
      title: string,
      kind: AgendaAttentionKind,
      region: AgendaAttentionRegion,
      since: string,
      source: AttentionSourceRow | undefined,
      risk: "low" | "medium" | "high" = "low",
      pinned = false,
      workTaskId: string | null = source?.work?.taskId ?? null,
    ) => ({
      ref,
      title,
      kind,
      region,
      workTaskId,
      attention: attentionScore({
        kind,
        since,
        now: input.now,
        risk: source?.snapshot.task?.metadata?.riskTier ?? risk,
        downstreamBlocked: source?.downstreamBlocked ?? 0,
        pinned: source?.snapshot.task?.pinned ?? pinned,
      }),
    }),
    candidates = [
      ...input.awaitingYou.map((row) =>
        add(`relation/${row.relationId}`, row.title, "awaiting-you", "mine", row.askedAt, sources.get(row.sourceRef)),
      ),
      ...input.answeredForYou.map((row) =>
        add(`relation/${row.relationId}`, row.title, "answered", "mine", row.answeredAt, sources.get(row.sourceRef)),
      ),
      ...input.awaitingRework.map((row) =>
        add(
          `task/${row.taskId}`,
          row.title,
          "rework",
          "mine",
          taskSource(row.taskId)?.updatedAt ?? input.now,
          taskSource(row.taskId),
          "low",
          row.pinned,
          row.work?.taskId ?? null,
        ),
      ),
      ...input.awaitingAdjudication.map((row) =>
        add(
          `execution/${row.executionId}`,
          row.title,
          "adjudication",
          "mine",
          row.submittedAt,
          taskSource(row.taskId),
          "low",
          row.pinned,
          row.work?.taskId ?? null,
        ),
      ),
      ...input.awaitingDecision.map((row) =>
        add(`decision/${row.decisionId}`, row.title, "decision", "mine", row.proposedAt, undefined, row.riskTier),
      ),
      ...input.waitingOnOthers.map((row) =>
        add(
          `task/${row.taskId}`,
          row.title,
          "blocked",
          "stuck",
          row.updatedAt,
          taskSource(row.taskId),
          "low",
          row.pinned,
          row.work?.taskId ?? null,
        ),
      ),
      ...input.stalled.map((row) =>
        add(
          `task/${row.taskId}`,
          row.title,
          "stalled",
          "stuck",
          row.updatedAt,
          taskSource(row.taskId),
          "low",
          row.pinned,
          row.work?.taskId ?? null,
        ),
      ),
    ],
    highest = new Map<string, (typeof candidates)[number]>();
  for (const item of candidates) {
    const previous = highest.get(item.ref);
    if (!previous || compareAttention(item, previous) < 0) highest.set(item.ref, item);
  }
  return [...highest.values()].sort(compareAttention);
}
