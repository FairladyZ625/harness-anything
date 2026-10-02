import type { ReactNode } from "react";

/**
 * 记录行原语(标准 §4.1 长值契约的共用记录布局):长 ID、状态词、长正文、
 * 时间与行尾动作的收缩/换行/容器响应只在这里定——
 * - 标识域与正文域都是 minmax(0,…) 列:长 ID 截断、长正文词内换行留在自身列,
 *   不越列不叠字;时间/动作在行尾 shrink-0 位,不被长值挤走。
 * - 换行断点按记录自身的容器宽度(@container + @min-[420px]),不猜 viewport
 *   或外栏宽度:窄容器单列堆叠,够宽才进三列。
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
  /** 长正文域:词内换行留在自身列。 */
  readonly summary: ReactNode;
  /** 时间域(行尾上方),可选。 */
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
      {/* 堆叠档也是 minmax(0,1fr) 轨道:auto 轨道按 max-content 取宽会让
          max-width:100% 在不定宽下失效(百分比当 none),长 ID 以自然宽撑破容器。 */}
      <div className="grid grid-cols-1 gap-2 py-3 @min-[420px]:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
        <div className="flex min-w-0 flex-col gap-0.5 break-words">
          {id}
          {state !== undefined ? state : null}
        </div>
        <div className="min-w-0 break-words">{summary}</div>
        {time !== undefined || action !== undefined ? (
          <div className="flex shrink-0 flex-col items-end gap-1">
            {time}
            {action}
          </div>
        ) : null}
      </div>
    </div>
  );
}
