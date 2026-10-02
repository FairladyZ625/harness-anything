import { Fragment, type ReactNode } from "react";
import { StatusTag, type StatusTone } from "./StatusTag";

/**
 * 步骤链(标准 §4「收束,不堆叠」):箭头串起的状态标签序列,单行呈现,超出容器宽在
 * 自身内部横向滚动——不换行、不随步骤数撑高外部行(与 PillFlow 分工:PillFlow 是有意
 * 多行的无序标签集,这是有序路径)。可点动作(行点击、行尾实体链接)留在链外,滚动
 * 手势不会误激活它们。滚动条隐藏(chain-strip):行高不随是否溢出变化;全部步骤仍可
 * 滚轮/触控板到达,语义在任务详情时间线同一词表可达。
 */
export function StepChain({
  steps,
  className = "",
}: {
  readonly steps: readonly {
    readonly label: ReactNode;
    readonly tone: StatusTone;
  }[];
  readonly className?: string;
}) {
  if (steps.length === 0) return null;
  return (
    <span data-step-chain="" className={`chain-strip flex min-w-0 items-center gap-1 overflow-x-auto ${className}`}>
      {steps.map((step, index) => (
        <Fragment key={index}>
          {index > 0 && <span className="flex-none text-text-faint ui-micro">→</span>}
          <StatusTag tone={step.tone} label={step.label} />
        </Fragment>
      ))}
    </span>
  );
}
