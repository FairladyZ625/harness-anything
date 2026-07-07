import { Fragment } from "react";
import type { CanonicalStatus, SnapshotStatus } from "../../model/types";
import { STEP_FLOW } from "./constants";

export function PhaseSteps({ status }: { status: SnapshotStatus }) {
  const idx = STEP_FLOW.indexOf(status as CanonicalStatus);
  if (idx < 0) {
    const note =
      status === "blocked"
        ? "blocked：暂离主流程，解除后回到 active"
        : status === "cancelled"
          ? "cancelled：终态，不参与阶段流"
          : "unknown：快照展示值，无阶段位置";
    return <p className="text-[11px] leading-relaxed text-text-faint">{note}</p>;
  }
  return (
    <div className="flex w-full items-center">
      {STEP_FLOW.map((s, i) => (
        <Fragment key={s}>
          {i > 0 && (
            <span className={`h-px min-w-1 flex-1 ${i <= idx ? "bg-accent" : "bg-border"}`} />
          )}
          <span
            className={`rounded px-1 py-0.5 font-mono text-[9px] ${
              i === idx
                ? "bg-accent font-semibold text-accent-fg"
                : i < idx
                  ? "text-text-muted"
                  : "text-text-faint"
            }`}
          >
            {s}
          </span>
        </Fragment>
      ))}
    </div>
  );
}
