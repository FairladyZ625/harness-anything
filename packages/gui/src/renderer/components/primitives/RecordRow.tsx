import type { ReactNode } from "react";
import { BoundedContent } from "./BoundedContent";

/**
 * 记录行原语(标准 §4.1 长值契约的共用记录布局):长 ID、状态词、长正文、
 * 时间与行尾动作的收缩/换行/容器响应只在这里定——
 * - 窄容器元数据分行，宽容器两轨都可收缩；时间/长派工号/多动作不能用
 *   intrinsic auto 轨道吃光标识宽度。正文独占下行，不受元数据排列影响。
 * - 长正文独占记录容器全宽(S7 实测:三列布局把评审正文挤进 ~320px 中列不可读):
 *   词内换行,读多少由记录实际拿到的宽度决定,不与标识/时间分列。
 * - 聚焦/选中态与 DenseRow.selected、DayDigest 行同一高亮语汇。
 * 各域内容的排版归调用方与展示叶(IdText/EntityRefLink 持有截断),本原语只
 * 拥有布局;调用方不给行传布局类。
 */

/** 聚焦/选中的同一高亮语汇(DenseRow.selected / DayDigest pathRowCls 共用)。 */
const FOCUS_CLS = "bg-accent/10 shadow-[inset_2px_0_0_var(--color-accent)]";

export function RecordRow({
  id,
  state,
  summary,
  time,
  action,
  focused = false,
  domId,
  testId,
}: {
  /** 标识域(长 ID):传展示叶 IdText/EntityRefLink,截断由叶与列收缩共同承担。 */
  readonly id: ReactNode;
  /** 标识域下方的状态词行(verdict/result 等),可选。 */
  readonly state?: ReactNode;
  /** 长正文域:独占全宽,词内换行。 */
  readonly summary: ReactNode;
  /** 时间域(元数据行行尾),可选。 */
  readonly time?: ReactNode;
  /** 行尾动作位(完整值复制等出口,标准 §4.1:不在截断文字上叠按钮),可选。 */
  readonly action?: ReactNode;
  /** 时间线聚焦态。 */
  readonly focused?: boolean;
  /** 滚动锚点(时间线聚焦 scrollIntoView 的目标)。 */
  readonly domId?: string;
  readonly testId?: string;
}) {
  return (
    <div
      id={domId}
      data-testid={testId}
      data-focused={focused || undefined}
      className={`@container ${focused ? FOCUS_CLS : ""}`}
    >
      <div className="grid min-w-0 grid-cols-1 items-start gap-x-3 gap-y-2 py-3 @[640px]:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-0.5 break-words">
          {id}
          {state !== undefined ? state : null}
        </div>
        {time !== undefined || action !== undefined ? (
          <div className="flex min-w-0 flex-col items-start gap-1 [overflow-wrap:anywhere] @[640px]:items-end">
            {time}
            {action}
          </div>
        ) : null}
      </div>
      <BoundedContent className="min-w-0 break-words pb-3">{summary}</BoundedContent>
    </div>
  );
}
