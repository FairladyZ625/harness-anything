import type { GateResult, GateStatus, TaskRow } from "./types.ts";
import type { MessageKey } from "../i18n/core.ts";

/**
 * 「卡在哪」只收真正的阻塞(rework-1 裁决):blocked 状态及其原因(依赖未完成/等人
 * 答复/成环)、被打回待返工、已 submit 后仍未通过的门与缺失的必填文档。提交前的
 * 完成门是「完成前还需要」,不是卡点——它们在收口页签的 Gate 签注卡里逐门列出。
 * 判定与渲染分离:本模块只出结构化条目,两个消费面(概况页签/任务抽屉)各自翻译。
 */

export type TaskStuckItem =
  | { readonly kind: "dependency"; readonly key: string; readonly targetTaskId: string; readonly rationale?: string }
  | {
      readonly kind: "awaits";
      readonly key: string;
      readonly personId: string;
      readonly question: string;
    }
  | { readonly kind: "cycle"; readonly key: "cycle" }
  | { readonly kind: "rework"; readonly key: "rework"; readonly nextIteration: number }
  | { readonly kind: "gate"; readonly key: string; readonly gate: GateResult }
  | { readonly kind: "doc"; readonly key: string; readonly path: string; readonly title: string };

/** kernel gate detail 机器码 → i18n 键(closeout-readiness/judgeGateWitnesses 的稳定原句)。 */
const GATE_DETAIL_KEYS: Readonly<Record<string, MessageKey>> = {
  "no submitted execution cut": "components.gateReason.awaitSubmission",
  "current execution cut has no code/doc witness": "components.gateReason.noCodeDocWitness",
  "current execution cut has no gate witness": "components.gateReason.noGateWitness",
  "current execution cut did not pass": "components.gateReason.notPassed",
  "witness projection unknown": "components.gateReason.projectionUnknown",
  "the gate's declared scope has no delivery part in this cut": "components.gateReason.notApplicableScope",
  "the automated witness passed; the mandatory human signoff is missing": "components.gateReason.signoffMissing",
  "checker reported fail": "components.gateReason.checkerFail",
  "the checker did not run": "components.gateReason.checkerNotRun",
};

/** 未映射 detail 的兜底:未过的门按状态给一句人话,原始 reason 码只进次级位置(title 提示)。 */
const GATE_STATUS_KEYS: Readonly<Partial<Record<GateStatus, MessageKey>>> = {
  failed: "components.gateReason.notPassed",
  missing: "components.gateReason.noGateWitness",
  signoff_missing: "components.gateReason.signoffMissing",
};

/**
 * 门禁原因文案键:已知机器码映射成键;未映射时未过的门按状态兜底。已满足的门
 * (waived 的动态回执原文等)返回 null,调用方保留原文——不把放行文案翻成失败。
 */
export function gateReasonKey(gate: GateResult): MessageKey | null {
  const mapped = gate.detail === undefined ? undefined : GATE_DETAIL_KEYS[gate.detail];
  if (mapped !== undefined) return mapped;
  const byStatus = gate.status === undefined ? undefined : GATE_STATUS_KEYS[gate.status];
  if (byStatus !== undefined) return byStatus;
  return gate.ok === false ? "components.gateReason.generic" : null;
}

export function taskStuckItems(task: TaskRow): readonly TaskStuckItem[] {
  const items: TaskStuckItem[] = [];
  // blocked 状态及其原因:blockers 由 kernel blockingOf 给出(依赖未完成/等人答复);
  // blocked 而 blockers 为空 = 阻塞关系成环。
  if (task.blocking === "blocked") {
    for (const blocker of task.blockers ?? []) {
      if (blocker.kind === "depends-on")
        items.push({
          kind: "dependency",
          key: blocker.relationId,
          targetTaskId: blocker.targetTaskId,
          ...(blocker.rationale ? { rationale: blocker.rationale } : {}),
        });
      else
        items.push({
          kind: "awaits",
          key: blocker.relationId,
          personId: blocker.personId,
          question: blocker.question,
        });
    }
    if (items.length === 0) items.push({ kind: "cycle", key: "cycle" });
  }
  // 被打回待返工:adjudicate return 把 execution 置 changes_requested、任务回 active
  // 并 +1 轮;新一轮还没有人认领(无 lease)时才算卡,认领后就是在做的活。
  const iteration = task.iteration ?? 0;
  if (
    task.coordinationStatus === "active" &&
    task.activeExecutionId === undefined &&
    (task.executions ?? []).some(
      (execution) => execution.state === "changes_requested" && execution.iteration === iteration - 1,
    )
  )
    items.push({ kind: "rework", key: "rework", nextIteration: iteration });
  // 已 submit 后仍未通过的门/缺失的必填文档才进「卡在哪」;提交前(含 done)不算。
  if (task.coordinationStatus === "submitted" || task.coordinationStatus === "in_review") {
    for (const gate of task.gates) if (gate.ok === false) items.push({ kind: "gate", key: gate.name, gate });
    for (const doc of task.docs)
      if (doc.required && doc.presence !== "unknown" && !doc.present)
        items.push({ kind: "doc", key: doc.path, path: doc.path, title: doc.title });
  }
  return items;
}
