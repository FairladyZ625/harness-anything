import type { ReactNode } from "react";

/**
 * 页头原语(视觉规范 §2.3,评审第 7 条统一摆法):所有列表页与目录页共用的一行页头——
 * 左侧页名 + 一句人话结论(弱色)+ 关键计数,右侧只放本页主动作。页头不装进带边框的
 * 面板、不铺通栏灰底;筛选与切换控件不进页头,它们在页头下方的筛选行。
 */
export function PageHeader({
  title,
  note,
  meta,
  actions,
  testId,
}: {
  readonly title: ReactNode;
  /** 一句话说明当前视图回答什么问题;写给业主,没有就不传。 */
  readonly note?: ReactNode;
  /** 关键计数(等宽弱色),如「12/34」。 */
  readonly meta?: ReactNode;
  /** 右侧控件区:本页主动作(最多一个主按钮),可带次要视图开关。 */
  readonly actions?: ReactNode;
  readonly testId?: string;
}) {
  return (
    <header data-testid={testId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3">
      <h1 className="text-xl font-semibold text-text">{title}</h1>
      {note !== undefined && note !== null ? (
        <span className="min-w-0 max-w-3xl truncate text-sm text-text-muted">{note}</span>
      ) : null}
      {meta !== undefined && meta !== null ? (
        <span className="min-w-0 shrink-0 font-mono tabular-nums ui-meta text-text-faint">{meta}</span>
      ) : null}
      {actions !== undefined && actions !== null ? (
        <div className="ml-auto flex flex-wrap items-center gap-1.5">{actions}</div>
      ) : null}
    </header>
  );
}
