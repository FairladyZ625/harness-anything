import type { ReactNode } from "react";
import type { GateResult } from "../../model/types.ts";
import { DenseRow } from "../primitives/DenseRow";
import { StatusTag } from "../primitives/StatusTag";
import { gateReasonKey, type TaskStuckItem } from "../../model/task-stuck.ts";
import { t } from "../../i18n/index.tsx";

/**
 * 「卡在哪」的行渲染(判定见 model/task-stuck.ts),概况页签与任务抽屉共用:
 * 每个条目一行 DenseRow + bad 底色状态标签;门禁原因走 gateReasonKey 的中英
 * 文案,原始机器 reason 码只进 title 提示,不占一级位置。标签措辞由调用面
 * 通过 copy 给出(概况页签是中文硬文案,抽屉走 i18n)。
 */
export interface StuckRowCopy {
  readonly dependency: string;
  readonly dependencyFallback: string;
  readonly awaits: string;
  readonly cycle: string;
  readonly cycleDetail: string;
  readonly rework: string;
  readonly reworkTitle: string;
  readonly reworkReason: (nextIteration: number) => string;
  readonly gateFailed: string;
  readonly missingDocument: string;
}

export function StuckRows({ items, copy }: { readonly items: readonly TaskStuckItem[]; readonly copy: StuckRowCopy }) {
  return (
    <div className="space-y-0.5">
      {items.map((item) => (
        <StuckRow key={item.key} item={item} copy={copy} />
      ))}
    </div>
  );
}

function StuckRow({ item, copy }: { readonly item: TaskStuckItem; readonly copy: StuckRowCopy }) {
  const bad = (label: string) => <StatusTag tone="bad" label={label} />;
  switch (item.kind) {
    case "dependency":
      return (
        <DenseRow
          tag={bad(copy.dependency)}
          title={item.targetTaskId}
          reason={item.rationale ?? copy.dependencyFallback}
        />
      );
    case "awaits":
      return <DenseRow tag={bad(copy.awaits)} title={item.personId} reason={item.question} />;
    case "cycle":
      return <DenseRow tag={bad(copy.cycle)} title={copy.cycleDetail} />;
    case "rework":
      return (
        <DenseRow tag={bad(copy.rework)} title={copy.reworkTitle} reason={copy.reworkReason(item.nextIteration)} />
      );
    case "gate":
      return <DenseRow tag={bad(copy.gateFailed)} title={item.gate.name} reason={gateReason(item.gate)} />;
    case "doc":
      return <DenseRow tag={bad(copy.missingDocument)} title={item.title} reason={item.path} />;
  }
}

/** 门禁原因:映射文案在一级位置,机器 reason 码进 title 提示(次级位置)。 */
function gateReason(gate: GateResult): ReactNode {
  const key = gateReasonKey(gate),
    text = key === null ? (gate.detail ?? "") : t(key);
  return gate.detail === undefined ? text : <span title={gate.detail}>{text}</span>;
}
