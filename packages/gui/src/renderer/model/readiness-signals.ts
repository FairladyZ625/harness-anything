import type { RelationCoverageRow } from "../../api/renderer-dto.ts";
import type { DecisionRow, FactRef } from "./types.ts";

/** U-13:drift/conflict remain unknown until a canonical projection exists. */
export type SignalColor = "green" | "yellow" | "red" | "unknown" | "na";

export interface ReadinessSignal {
  id: "evidence-liveness" | "applies-to-drift" | "coverage" | "conflict-marker";
  label: string;
  color: SignalColor;
  summary: string;
}

type GraphState = "ready" | "loading" | "error";

const factAnchor = (ref: string) => ref.replace(/^fact\//u, "");

export function computeReadinessSignals(
  decision: DecisionRow,
  facts: FactRef[],
  coverageRows: ReadonlyArray<RelationCoverageRow> = [],
  graphState: GraphState = "ready",
): ReadinessSignal[] {
  const loadBearing = decision.claims.filter((claim) => claim.loadBearing);
  const claimRefs = new Set(loadBearing.map((claim) => `decision/${decision.decisionId}/${claim.id}`));
  const rows = coverageRows.filter((row) => row.decisionRef === `decision/${decision.decisionId}` && claimRefs.has(row.claimRef));
  const byClaim = new Map(rows.map((row) => [row.claimRef, row]));
  const missingRows = loadBearing.filter((claim) => !byClaim.has(`decision/${decision.decisionId}/${claim.id}`));

  const evidence = evidenceLiveness(loadBearing.length, rows, missingRows.length, facts, graphState);
  const coverage = coverageSignal(loadBearing.length, rows, missingRows, graphState);

  return [
    evidence,
    {
      id: "applies-to-drift",
      label: "applies_to 漂移",
      color: "unknown",
      summary: "未投影:drift/conflict 的 canonical GUI facet 尚未裁定(U-13 defer),不得用本地猜测落绿。",
    },
    coverage,
    {
      id: "conflict-marker",
      label: "冲突标记",
      color: "unknown",
      summary: "未投影:drift/conflict 的 canonical GUI facet 尚未裁定(U-13 defer),不得用本地猜测落绿。",
    },
  ];
}

function evidenceLiveness(
  loadBearingCount: number,
  rows: ReadonlyArray<RelationCoverageRow>,
  missingRowCount: number,
  facts: FactRef[],
  graphState: GraphState,
): ReadinessSignal {
  if (loadBearingCount === 0) return { id: "evidence-liveness", label: "evidence 活性", color: "na", summary: "N/A · 无 load-bearing claim。" };
  if (graphState !== "ready") return { id: "evidence-liveness", label: "evidence 活性", color: "unknown", summary: `relation graph ${graphState};缺字段不作绿灯。` };
  if (missingRowCount > 0) return { id: "evidence-liveness", label: "evidence 活性", color: "unknown", summary: `${missingRowCount} 个 load-bearing claim 缺 coverageRows;不猜 evidence。` };
  const refs = [...new Set(rows.flatMap((row) => [row.coveringFactRef, ...row.refutingFactRefs]).filter((ref): ref is string => Boolean(ref)))];
  const basis = [...new Set(rows.map((row) => row.basisRevision))].sort((a, b) => a - b).join(",");
  if (refs.length === 0) return { id: "evidence-liveness", label: "evidence 活性", color: "na", summary: `N/A · coverageRows 无 covering/refuting fact · basisRevision ${basis}。` };
  const resolved = refs.map((ref) => ({ ref, fact: facts.find((item) => item.anchor === factAnchor(ref)) }));
  const missing = resolved.filter((item) => !item.fact).map((item) => item.ref);
  if (missing.length) return { id: "evidence-liveness", label: "evidence 活性", color: "unknown", summary: `coverageRows 引用的 fact 尚未投影:${missing.join(", ")} · basisRevision ${basis}。` };
  const invalidated = resolved.filter((item) => item.fact?.invalidated).map((item) => item.ref);
  return invalidated.length
    ? { id: "evidence-liveness", label: "evidence 活性", color: "yellow", summary: `${invalidated.length} 条 covering/refuting fact 已 invalidated:${invalidated.join(", ")} · basisRevision ${basis}。` }
    : { id: "evidence-liveness", label: "evidence 活性", color: "green", summary: `${refs.length} 条 covering/refuting fact 均 active · basisRevision ${basis}。` };
}

function coverageSignal(
  loadBearingCount: number,
  rows: ReadonlyArray<RelationCoverageRow>,
  missingRows: ReadonlyArray<DecisionRow["claims"][number]>,
  graphState: GraphState,
): ReadinessSignal {
  if (loadBearingCount === 0) return { id: "coverage", label: "覆盖度", color: "na", summary: "N/A · 无 load-bearing claim。" };
  if (graphState !== "ready") return { id: "coverage", label: "覆盖度", color: "unknown", summary: `relation graph ${graphState};缺字段不作绿灯。` };
  if (missingRows.length) return { id: "coverage", label: "覆盖度", color: "unknown", summary: `coverageRows 缺 claim:${missingRows.map((claim) => claim.id).join(", ")};不从 option evidence 猜。` };
  const uncovered = rows.filter((row) => row.status === "uncovered");
  const revisions = [...new Set(rows.map((row) => row.basisRevision))].sort((a, b) => a - b).join(",");
  return uncovered.length
    ? { id: "coverage", label: "覆盖度", color: "red", summary: `canonical coverageRows:${loadBearingCount - uncovered.length}/${loadBearingCount};未覆盖 ${uncovered.map((row) => row.claimRef.split("/").at(-1)).join(", ")} · basisRevision ${revisions}。` }
    : { id: "coverage", label: "覆盖度", color: "green", summary: `canonical coverageRows:${loadBearingCount}/${loadBearingCount} · basisRevision ${revisions}。` };
}

/** 红 > 黄 > unknown > 绿；N/A 不会把 unknown 覆成“全绿”。 */
export function worstColor(signals: ReadinessSignal[]): SignalColor {
  if (signals.some((signal) => signal.color === "red")) return "red";
  if (signals.some((signal) => signal.color === "yellow")) return "yellow";
  if (signals.some((signal) => signal.color === "unknown")) return "unknown";
  if (signals.some((signal) => signal.color === "green")) return "green";
  return "na";
}
