import { Fragment, type ReactNode } from "react";
import { ChainStrip } from "./ChainStrip";
import { StatusTag, type StatusTone } from "./StatusTag";

/**
 * 步骤链(标准 §4「收束,不堆叠」):箭头串起的状态标签序列,滚动/键盘/溢出提示
 * 契约由共享的 ChainStrip 承担(超出容器宽在链内部横向滚动,溢出时可键盘聚焦平移,
 * 行高不随步骤数或是否溢出变化)。与 PillFlow 分工:PillFlow 是有意多行的无序标签集,
 * 这是有序路径。链上无动作:行点击、行尾实体链接等可点面留在链外,滚动手势不会
 * 误激活它们。
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
  const ariaLabel = steps
    .map((step) => (typeof step.label === "string" ? step.label : ""))
    .filter((label) => label !== "")
    .join(" → ");
  return (
    <ChainStrip testId="step-chain" label={ariaLabel} className={className}>
      {steps.map((step, index) => (
        <Fragment key={index}>
          {index > 0 && <span className="flex-none text-text-faint ui-micro">→</span>}
          <StatusTag tone={step.tone} label={step.label} />
        </Fragment>
      ))}
    </ChainStrip>
  );
}
