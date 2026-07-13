import { Fragment } from "react";
import type { CanonicalStatus, SnapshotStatus } from "../../model/types";
import { STEP_FLOW } from "./constants";
import { t } from "../../i18n/index.tsx";

export function PhaseSteps({ status }: { status: SnapshotStatus }) {
  const idx = STEP_FLOW.indexOf(status as CanonicalStatus);
  if (idx < 0) {
    const note =
      status === "blocked"
        ? t("components.phaseSteps.blockedTemporarilyLeaveMainProcessReturnActive")
        : status === "cancelled"
          ? t("components.phaseSteps.canceledFinalStateNotParticipatingStageFlow")
          : t("components.phaseSteps.unknownSnapshotDisplayValueNoStagePosition");
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
