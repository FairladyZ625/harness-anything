export type AgendaAttentionKind =
  | "awaiting-you"
  | "rework"
  | "adjudication"
  | "decision"
  | "blocked"
  | "stalled"
  | "answered"
  | "archive";

export type AgendaAttentionRegion = "mine" | "stuck";

export interface AgendaAttention {
  readonly score: number;
  readonly reasons: readonly { readonly label: string; readonly contribution: number }[];
}

export interface AgendaAttentionItem {
  readonly ref: string;
  readonly region: AgendaAttentionRegion;
  readonly attention: AgendaAttention;
}

const BASE = {
  "awaiting-you": ["等你答复", 100],
  rework: ["评审打回", 70],
  adjudication: ["待裁决", 60],
  decision: ["决策待点头", 50],
  blocked: ["阻塞", 45],
  stalled: ["进行中停滞", 40],
  answered: ["已答复待跟进", 30],
  archive: ["已结束可归档", 5],
} as const satisfies Record<AgendaAttentionKind, readonly [string, number]>;

export function attentionScore(input: {
  readonly kind: AgendaAttentionKind;
  readonly since: string;
  readonly now: string;
  readonly risk: "low" | "medium" | "high";
  readonly downstreamBlocked: number;
  readonly pinned: boolean;
}): AgendaAttention {
  const [baseLabel, base] = BASE[input.kind],
    reasons: { label: string; contribution: number }[] = [{ label: baseLabel, contribution: base }];
  let score = base;
  if (input.risk === "high") {
    const contribution = Math.round(score * 0.5);
    score *= 1.5;
    reasons.push({ label: "高风险 ×1.5", contribution });
  }
  if (input.downstreamBlocked > 0) {
    const contribution = Math.min(input.downstreamBlocked, 5) * 12;
    reasons.push({
      label: `阻塞 ${input.downstreamBlocked} 个下游任务${input.downstreamBlocked > 5 ? "（最多计 5 个）" : ""}`,
      contribution,
    });
    score += contribution;
  }
  const hours = Math.max(0, (Date.parse(input.now) - Date.parse(input.since)) / 3_600_000);
  if (input.kind === "blocked" || input.kind === "stalled") {
    const days = Math.round(hours / 24),
      contribution = Math.min(days * 2, 20);
    reasons.push({ label: `${days} 天无活动（每天 +2，封顶 20）`, contribution });
    score += contribution;
  } else if (input.kind !== "archive") {
    const roundedHours = Math.round(hours),
      contribution = Math.min(40, Math.round(8 * Math.log2(1 + hours)));
    reasons.push({ label: `已等待 ${roundedHours} 小时（对数增长，封顶 40）`, contribution });
    score += contribution;
  }
  if (input.pinned) {
    reasons.push({ label: "已置顶", contribution: 20 });
    score += 20;
  }
  return { score: Math.round(score), reasons };
}

export function compareAttention(left: AgendaAttentionItem, right: AgendaAttentionItem): number {
  return right.attention.score - left.attention.score || left.ref.localeCompare(right.ref);
}

export function attentionRegionWeights(
  items: readonly AgendaAttentionItem[],
  counts: {
    readonly running: number;
    readonly review: number;
    readonly queue: number;
    readonly worksNeedingAttention: number;
  },
) {
  const score = (region: AgendaAttentionRegion) =>
    items.filter((item) => item.region === region).reduce((sum, item) => sum + item.attention.score, 0);
  return {
    mine: items.some(({ region }) => region === "mine") ? 6 + score("mine") / 14 : 1.5,
    stuck: 3 + score("stuck") / 45,
    run: 3 + counts.running * 2.5,
    review: 3 + counts.review * 2,
    queue: counts.queue > 0 ? 3.5 : 0,
    recent: 4,
    works: 8 + counts.worksNeedingAttention * 0.8,
  } as const;
}
