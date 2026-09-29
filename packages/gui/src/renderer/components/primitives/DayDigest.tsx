import { Fragment, useState, type ReactNode } from "react";
import { t } from "../../i18n/index.tsx";
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
}

/**
 * 按天收束的进展(标准 §4):一句话摘要,点开是每个任务一行的路径,
 * StatusTag 用箭头串起(收束,不堆叠——标准 §1)。
 */
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
        className="flex w-full items-baseline gap-3 text-left"
      >
        <span className="w-11 flex-none font-mono font-semibold text-text-muted ui-meta">{day}</span>
        <span className="min-w-0 flex-1 ui-body">{summary}</span>
        <span className="flex-none text-text-faint ui-meta">
          {open ? t("components.primitives.collapse") : t("components.primitives.expand")}
        </span>
      </button>
      {open && (
        <div className="my-1 ml-14">
          {paths.map((path, index) => {
            const content = (
              <>
                {path.time !== undefined && (
                  <span className="w-9 flex-none font-mono text-text-faint ui-micro">{path.time}</span>
                )}
                <span className="max-w-[48%] min-w-0 flex-none truncate ui-body group-hover:text-accent">
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
            if (path.onClick === undefined) {
              return (
                <div key={index} className="flex items-baseline gap-2 py-[3px]">
                  {content}
                </div>
              );
            }
            return (
              <button
                key={index}
                type="button"
                onClick={path.onClick}
                className="group flex w-full cursor-pointer items-baseline gap-2 py-[3px] text-left"
              >
                {content}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
