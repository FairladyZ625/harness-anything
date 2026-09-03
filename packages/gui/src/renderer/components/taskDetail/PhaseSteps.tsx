import { Fragment } from "react";
import { t } from "../../i18n/index.tsx";
import type { TaskRow } from "../../model/types";

/**
 * 阶段投影(kernel `taskPhase`)的 reason 码 → 注释文案键。判定(为何没有阶段位)
 * 来自 daemon 的 `phase.reason`;renderer 只把码翻成措辞,不再比较状态词。
 */
const REASON_NOTE = {
  blocked_overlay: "views.taskDetailView.phaseBlockedOverlay",
  terminal_cancelled: "views.taskDetailView.phaseTerminalCancelled",
  phase_unresolved: "views.taskDetailView.phaseUnresolved",
} as const satisfies Record<NonNullable<TaskRow["phase"]["reason"]>, string>;

/** 主路径步进条;偏离主路径的行只显示 reason 注释,不猜它的阶段位。 */
export function PhaseSteps({ phase }: { phase: TaskRow["phase"] }) {
  const idx = phase.index,
    reason = phase.reason ?? "phase_unresolved";
  if (idx === null) {
    return <p className="ui-micro leading-relaxed text-text-faint">{t(REASON_NOTE[reason])}</p>;
  }
  return (
    <div className="flex w-full items-center">
      {phase.steps.map((s, i) => (
        <Fragment key={s}>
          {i > 0 && <span className={`h-px min-w-1 flex-1 ${i <= idx ? "bg-accent" : "bg-border"}`} />}
          <span
            className={`rounded px-1 py-0.5 font-mono ui-micro ${
              i === idx ? "bg-accent font-semibold text-accent-fg" : i < idx ? "text-text-muted" : "text-text-faint"
            }`}
          >
            {s}
          </span>
        </Fragment>
      ))}
    </div>
  );
}
