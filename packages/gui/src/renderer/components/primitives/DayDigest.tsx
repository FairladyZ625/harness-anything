import { Fragment, useState, type ReactNode } from "react";
import { t } from "../../i18n/index.tsx";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { StatusTag, type StatusTone } from "./StatusTag";

export interface DayPathStep {
  readonly label: string;
  readonly tone: StatusTone;
}

export interface DayPath {
  readonly time?: string;
  readonly name: string;
  readonly steps: readonly DayPathStep[];
  readonly onClick?: () => void;
  /** 外部列表(如放大层)的选中态,与 DenseRow 同一高亮语汇;平铺场景不传。 */
  readonly selected?: boolean;
  /** 行尾弱色编号(机器 id):主文字是人话,编号从这可达(视觉基线 v2)。 */
  readonly ref?: string;
  /**
   * 行尾编号的结构化落点(execution/<id> 等事件源拼好的 recordRef):给出它与
   * onOpenRecord,编号经 EntityRefLink 渲染成可激活路径;缺省仍是纯文本编号。
   */
  readonly recordRef?: string;
  readonly onOpenRecord?: (recordRef: string) => void;
  /** 行悬停全文:主文字被收束(可读名、人话步骤)时,原始串放这里。 */
  readonly title?: string;
}

/**
 * 按天收束的进展(标准 §4):一句话摘要,点开是每个任务一行的路径,
 * StatusTag 用箭头串起(收束,不堆叠——标准 §1)。
 */

/** 选中行的高亮与 DenseRow.selected 同一语汇(左侧 2px 强调竖线 + 轻底)。 */
function pathRowCls(selected: boolean | undefined): string {
  return `flex items-baseline gap-2 py-[3px] ${
    selected === true ? "bg-accent/10 shadow-[inset_2px_0_0_var(--color-accent)]" : ""
  }`;
}
export function DayDigest({
  day,
  summary,
  paths,
  defaultOpen = false,
}: {
  readonly day: string;
  readonly summary: ReactNode;
  readonly paths: readonly DayPath[];
  readonly defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-border py-2 first:border-t-0" data-day={day}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="relative flex w-full items-baseline gap-3 text-left after:absolute after:content-[''] after:inset-x-0 after:-top-[2px] after:-bottom-[2px]"
      >
        <span className="min-w-11 flex-none whitespace-nowrap font-mono font-semibold text-text-muted ui-meta">
          {day}
        </span>
        <span className="min-w-0 flex-1 ui-body">{summary}</span>
        <span className="flex-none text-text-faint ui-meta">
          {open ? t("components.primitives.collapse") : t("components.primitives.expand")}
        </span>
      </button>
      {open && (
        <div className="my-1 ml-14">
          {paths.map((path, index) => {
            const openRecord =
              path.recordRef !== undefined && path.onOpenRecord !== undefined ? path.onOpenRecord : undefined;
            const main = (
              <>
                {path.time !== undefined && (
                  <span className="w-9 flex-none font-mono text-text-faint ui-micro">{path.time}</span>
                )}
                {/* 没有步骤的路径(如任务的生命周期记录)名字占满整行,不给空的步骤列留一半宽度;带行尾编号时名字不收缩,由编号截断。 */}
                <span
                  className={`min-w-0 truncate ui-body group-hover:text-accent ${
                    path.ref !== undefined
                      ? "max-w-[60%] flex-none"
                      : path.steps.length === 0
                        ? "flex-1"
                        : "max-w-[48%] flex-none"
                  }`}
                >
                  {path.name}
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-1">
                  {path.steps.map((step, stepIndex) => (
                    <Fragment key={stepIndex}>
                      {stepIndex > 0 && <span className="text-text-faint ui-micro">→</span>}
                      <StatusTag tone={step.tone} label={step.label} />
                    </Fragment>
                  ))}
                </span>
              </>
            );
            const refTail =
              path.ref === undefined ? null : openRecord !== undefined ? (
                <EntityRefLink
                  entityRef={path.recordRef!}
                  onNavigate={openRecord}
                  title={path.title ?? path.ref}
                  className="min-w-0 flex-1 truncate text-right font-mono ui-micro text-accent hover:underline"
                >
                  {path.ref}
                </EntityRefLink>
              ) : (
                <span
                  className="min-w-0 flex-1 truncate text-right font-mono text-text-faint ui-micro"
                  title={path.title ?? path.ref}
                >
                  {path.ref}
                </span>
              );
            // 行链与行尾实体链接并存时,行退化为纯行,两个动作各是原生 button——
            // button 里嵌 button 是非法 HTML,会破坏两个动作的可达性。
            if (openRecord !== undefined && path.onClick !== undefined) {
              return (
                <div
                  key={index}
                  data-selected={path.selected || undefined}
                  className={`group ${pathRowCls(path.selected)}`}
                >
                  <button
                    type="button"
                    onClick={path.onClick}
                    title={path.title}
                    className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-2 text-left"
                  >
                    {main}
                  </button>
                  {refTail}
                </div>
              );
            }
            if (path.onClick === undefined) {
              return (
                <div
                  key={index}
                  data-selected={path.selected || undefined}
                  title={path.title}
                  className={pathRowCls(path.selected)}
                >
                  {main}
                  {refTail}
                </div>
              );
            }
            return (
              <button
                key={index}
                type="button"
                onClick={path.onClick}
                data-selected={path.selected || undefined}
                title={path.title}
                className={`group w-full cursor-pointer text-left ${pathRowCls(path.selected)}`}
              >
                {main}
                {refTail}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
