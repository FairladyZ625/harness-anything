import type { DecisionRow, FactRef } from "../model/types";
import { coverageOf } from "../model/triadic";
import { t } from "../i18n/index.tsx";

export type SignalColor = "green" | "yellow" | "red";

export interface ReadinessSignal {
  id: "evidence-liveness" | "applies-to-drift" | "coverage" | "conflict-marker";
  label: string;
  color: SignalColor;
  /** 判定摘要:命中时给"为什么黄/红",hover/展开时看 */
  summary: string;
  /** true when the signal is not projected for real data (unknown, not green). */
  unknown?: boolean;
}

const dateLabel = (iso?: string) => (iso ? iso.slice(0, 16).replace("T", " ") : "—");

/**
 * 计算决策就绪信号灯(41 §3.1a)。
 *
 * evidence 活性 + 覆盖度可从 relation/fact 推导。applies_to 漂移 + 冲突标记
 * 依赖专用投影字段;当 `readinessSignals` 未投影时,这两盏灯标记为 unknown,
 * 不伪装成绿灯(P2-1 诚实路径)。
 */
export function computeReadinessSignals(
  d: DecisionRow,
  facts: FactRef[],
): ReadinessSignal[] {
  const signals: ReadinessSignal[] = [];
  const projectionPresent = d.readinessSignals !== undefined;

  // ① evidence 活性(黄):引用的 fact 被 invalidated-by/supersedes-fact 边指向
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
    label: t("views.decisionsVerdict.evidenceActivity"),
    color: deadEvidence.length > 0 ? "yellow" : "green",
    summary:
      deadEvidence.length > 0
        ? t("views.decisionsVerdict.countPiecesEvidenceReferInvalidatedFactValue", {
            count: deadEvidence.length,
            value: deadEvidence.join(", "),
          })
        : t("views.decisionsVerdict.allReferencedFactsLiveNotPointedBy"),
  });

  // ② applies_to 漂移 —— 仅当投影提供 readinessSignals 时才判定,否则 unknown
  if (projectionPresent) {
    const drift = d.readinessSignals?.appliesToDrift;
    signals.push({
      id: "applies-to-drift",
      label: t("views.decisionsVerdict.appliesDrift"),
      color: drift ? "yellow" : "green",
      summary: drift
        ? t("views.decisionsVerdict.afterProposeAppliesDocumentTouchedValueRecent", {
            value: drift.docs.join(", "),
            value2: dateLabel(drift.lastCommitAt),
          })
        : t("views.decisionsVerdict.applyDocumentHasNoCommitTouchAfter"),
    });
  } else {
    signals.push({
      id: "applies-to-drift",
      label: t("views.decisionsVerdict.appliesDrift"),
      color: "green",
      unknown: true,
      summary: t("views.decisionsVerdict.driftConflictNotProjected"),
    });
  }

  // ③ 覆盖度(红):承重论点 → 活 fact 不可达
  const cov = coverageOf(d, facts);
  signals.push({
    id: "coverage",
    label: t("views.decisionsVerdict.coverage"),
    color: cov.total > 0 && cov.covered < cov.total ? "red" : "green",
    summary:
      cov.total === 0
        ? t("views.decisionsVerdict.noLoadBearingArgument")
        : cov.covered < cov.total
          ? t("views.decisionsVerdict.loadBearingArgumentValueUnreachableFactCovered", {
              value: cov.gaps.join(", "),
              covered: cov.covered,
              total: cov.total,
            })
          : t("views.decisionsVerdict.coveredTotalArgumentFactual", {
              covered: cov.covered,
              total: cov.total,
            }),
  });

  // ④ 冲突标记 —— 仅当投影提供 readinessSignals 时才判定,否则 unknown
  if (projectionPresent) {
    const conflict = d.readinessSignals?.conflictMarker;
    signals.push({
      id: "conflict-marker",
      label: t("views.decisionsVerdict.conflictFlag"),
      color: conflict ? "red" : "green",
      summary: conflict
        ? t(
            "views.decisionsVerdict.findConflictMarkersHitsSummaryConflictingEntityConflictingEntityCoordinator",
            { summary: conflict.summary, conflictingEntity: conflict.conflictingEntity },
          )
        : t("views.decisionsVerdict.findConflictMarkersMissed"),
    });
  } else {
    signals.push({
      id: "conflict-marker",
      label: t("views.decisionsVerdict.conflictFlag"),
      color: "green",
      unknown: true,
      summary: t("views.decisionsVerdict.driftConflictNotProjected"),
    });
  }

  return signals;
}

/** 取四盏灯里最严重的色(红 > 黄 > 绿);unknown 灯不参与「全绿」判定。 */
export function worstColor(signals: ReadinessSignal[]): SignalColor {
  const known = signals.filter((s) => !s.unknown);
  if (known.some((s) => s.color === "red")) return "red";
  if (known.some((s) => s.color === "yellow")) return "yellow";
  return "green";
}

/** true when any projected signal is unknown (P2-1 honesty). */
export function hasUnknownSignals(signals: ReadinessSignal[]): boolean {
  return signals.some((s) => s.unknown);
}

/** mock 的 coordinator 结构化拒因(冲突标记红灯 accept 时渲染,E52 R3) */
export function buildConflictRejection(
  d: DecisionRow,
): { code: string; reason: string; detail: string[] } {
  const conflict = d.readinessSignals?.conflictMarker;
  return {
    code: "E_CONFLICT_MARKER",
    reason: t(
      "views.decisionsVerdict.acceptWasRejectedByCoordinatorPreflightFindConflictMarkers",
    ),
    detail: conflict
      ? [
          `conflictingEntity: ${conflict.conflictingEntity}`,
          `summary: ${conflict.summary}`,
          t(
            "views.decisionsVerdict.actionFirstResolveConcurrentModificationConflictConflictingEntity",
            { conflictingEntity: conflict.conflictingEntity },
          ),
        ]
      : [t("views.decisionsVerdict.actionRetryAfterResolvingConcurrencyConflicts")],
  };
}

/**
 * 两轴正交排序键(riskTier × urgency)。⚠ 不得合并为单一分数(TP-M3-01 两轴正交)。
 * 返回元组,lexicographic 比较即"先按 riskTier,同级再按 urgency"。
 * high=0 / medium=1 / low=2 —— 承重决策优先承重,承重同级里紧急优先。
 */
const axisRank = (v?: "high" | "medium" | "low") =>
  v === "high" ? 0 : v === "medium" ? 1 : v === "low" ? 2 : 3;
export const sortKey = (d: DecisionRow): readonly [number, number] =>
  [axisRank(d.riskTier), axisRank(d.urgency)] as const;
