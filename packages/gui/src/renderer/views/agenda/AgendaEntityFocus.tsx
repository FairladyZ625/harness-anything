import { useState } from "react";
import { t } from "../../i18n/index.tsx";
import type { TaskRow } from "../../model/types.ts";
import { SegCtl } from "../../components/primitives/SegCtl.tsx";
import { ViewInGraphButton } from "../../components/ViewInGraphButton.tsx";
import { TaskCausalTimeline } from "../../components/taskDetail/TaskDetailSections.tsx";
import { EntityFocalNeighborhood } from "../EntityDetailView.tsx";

/** Keyed by the agenda item: selection resets both the mode and the focal canvas together. */
export function AgendaEntityFocus({
  repoId,
  focusRef,
  task,
  tasks,
  onNavigateEntity,
  onFocusGraph,
}: {
  readonly repoId: string;
  readonly focusRef: string;
  readonly task?: TaskRow;
  readonly tasks: readonly TaskRow[];
  readonly onNavigateEntity: (ref: string) => void;
  readonly onFocusGraph?: (ref: string) => void;
}) {
  const [mode, setMode] = useState<"journey" | "neighborhood">("journey");
  const isTask = focusRef.startsWith("task/");
  return (
    <section
      data-testid="agenda-entity-focus"
      data-focus-ref={focusRef}
      className="flex min-w-0 shrink-0 flex-col gap-2 border-t border-border pt-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        {isTask && (
          <SegCtl
            value={mode}
            onChange={setMode}
            label={t("views.agenda.entityFocus")}
            options={[
              { value: "journey", label: t("views.agenda.taskJourney"), testId: "agenda-focus-journey" },
              { value: "neighborhood", label: t("views.agenda.oneHop"), testId: "agenda-focus-neighborhood" },
            ]}
          />
        )}
        <ViewInGraphButton entityRef={focusRef} onFocusGraph={onFocusGraph} />
      </div>
      {isTask && mode === "journey" ? (
        task ? (
          <TaskCausalTimeline key={focusRef} task={task} tasks={tasks} onNavigateEntity={onNavigateEntity} />
        ) : (
          <p role="status" className="ui-meta text-text-muted">
            {t("views.agenda.tasksPending")}
          </p>
        )
      ) : (
        <div className="flex h-[var(--long-content-cap)] min-h-0 min-w-0 flex-col">
          <EntityFocalNeighborhood
            repoId={repoId}
            focusRef={focusRef}
            tasks={tasks}
            onNavigateEntity={onNavigateEntity}
          />
        </div>
      )}
    </section>
  );
}
