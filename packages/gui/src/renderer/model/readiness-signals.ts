import type { DecisionRow, FactRef } from "./types";
import { coverageOf } from "./triadic";

/**
 * 决策就绪信号灯(41 §3.1a):纯逻辑,从 decisions-verdict.tsx 提取以控文件复杂度。
 *
 * 缺失信号处理(UNKNOWN-001 验收硬项):
 *   readinessSignals 整块缺失 → unknown(未投影,不得落绿)。
 *   readinessSignals 存在但某字段缺失 → 已检查无命中 → green。
 */

export type SignalColor = "green" | "yellow" | "red" | "unknown";

export interface ReadinessSignal {
  id: "evidence-liveness" | "applies-to-drift" | "coverage" | "conflict-marker";
  label: string;
  color: SignalColor;
  summary: string;
}

const dateLabel = (iso?: string) => (iso ? iso.slice(0, 16).replace("T", " ") : "—");

export function computeReadinessSignals(d: DecisionRow, facts: FactRef[]): ReadinessSignal[] {
  const signals: ReadinessSignal[] = [];

  // ① evidence 活性(黄)
  const deadEvidence: string[] = [];
  for (const c of [...d.chosen, ...d.rejected]) {
    for (const ref of c.evidence) {
      const anchor = ref.replace(/^fact\//, "");
      const f = facts.find((x) => x.anchor === anchor);
      if (f?.invalidated) deadEvidence.push(anchor);
    }
  }
  signals.push({
    id: "evidence-liveness",
    label: "evidence 活性",
    color: deadEvidence.length > 0 ? "yellow" : "green",
    summary: deadEvidence.length > 0
      ? `${deadEvidence.length} 条 evidence 引用了已失效 fact:${deadEvidence.join(", ")}`
      : "所有引用的 fact 均为活",
  });

  // ② applies_to 漂移(黄/unknown)
  const drift = d.readinessSignals?.appliesToDrift;
  const driftUnknown = d.readinessSignals === undefined;
  signals.push({
    id: "applies-to-drift",
    label: "applies_to 漂移",
    color: drift ? "yellow" : driftUnknown ? "unknown" : "green",
    summary: drift
      ? `applies_to 文档被触碰:${drift.docs.join(", ")} · ${dateLabel(drift.lastCommitAt)}`
      : driftUnknown
        ? "未投影:drift 信号尚未由 provenance.boundAt × git log 推导(U-03 未裁)"
        : "applies_to 文档无 commit 触碰",
  });

  // ③ 覆盖度(红)
  const cov = coverageOf(d, facts);
  signals.push({
    id: "coverage",
    label: "覆盖度",
    color: cov.total > 0 && cov.covered < cov.total ? "red" : "green",
    summary: cov.total === 0
      ? "无承重论点"
      : cov.covered < cov.total
        ? `承重论点 ${cov.gaps.join(", ")} 无可达活 fact(${cov.covered}/${cov.total})`
        : `${cov.covered}/${cov.total} 论点有可达活 fact`,
  });

  // ④ 冲突标记(红/unknown)
  const conflict = d.readinessSignals?.conflictMarker;
  const conflictUnknown = d.readinessSignals === undefined;
  signals.push({
    id: "conflict-marker",
    label: "冲突标记",
    color: conflict ? "red" : conflictUnknown ? "unknown" : "green",
    summary: conflict
      ? `findConflictMarkers 命中:${conflict.summary}(冲突实体 ${conflict.conflictingEntity})`
      : conflictUnknown
        ? "未投影:conflict marker 尚未由 findConflictMarkers 推导(U-03 未裁)"
        : "findConflictMarkers 未命中",
  });

  return signals;
}

/** 取四盏灯里最严重的色(红 > 黄 > unknown > 绿) */
export function worstColor(signals: ReadinessSignal[]): SignalColor {
  if (signals.some((s) => s.color === "red")) return "red";
  if (signals.some((s) => s.color === "yellow")) return "yellow";
  if (signals.some((s) => s.color === "unknown")) return "unknown";
  return "green";
}
