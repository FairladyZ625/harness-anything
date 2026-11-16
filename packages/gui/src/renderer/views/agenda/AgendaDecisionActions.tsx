import { reviewAcceptBlockedReason } from "../../components/decisionReview/parts.tsx";
import { useState } from "react";
import { useDecisionShowQuery } from "../../decision-show-data.ts";
import { useDecisionActions } from "../../decision-actions.ts";
import { adaptDecisionRows, useEntityRelationGraphQuery } from "../../triadic-data.ts";
import { DecisionJudgmentPanel } from "../../components/DecisionJudgmentPanel.tsx";
import { EntityRefLink } from "../../components/EntityRefLink.tsx";
import { Button } from "../../components/primitives/Button.tsx";
import type { AgendaWorkbenchItem } from "../../model/agenda-workbench.ts";
import type { TaskRow } from "../../model/types.ts";
import { t } from "../../i18n/index.tsx";
import { useAgendaContinuation } from "./useAgendaContinuation.ts";
import { AgendaContinuationFeedback } from "./AgendaContinuationFeedback.tsx";

/** Exactly the selected Decision, using the same detail, judgment and relation contracts. */
export function AgendaDecisionActions({
  repoId,
  item,
  tasks,
  onNavigateEntity,
  onRetain,
}: {
  readonly repoId: string;
  readonly item: AgendaWorkbenchItem;
  readonly tasks: readonly TaskRow[];
  readonly onNavigateEntity: (ref: string) => void;
  readonly onRetain: () => void;
}) {
  const id = item.row.id;
  const read = useDecisionShowQuery(repoId, id);
  const graph = useEntityRelationGraphQuery(repoId, `decision/${id}`);
  const actions = useDecisionActions(repoId);
  const [accepted, setAccepted] = useState(false);
  const [childId, setChildId] = useState<string | null>(null);
  const continuation = useAgendaContinuation(repoId, childId);
  const decision =
    read.data?.status === "ready" ? adaptDecisionRows([read.data.decision], graph.relations, [])[0] : null;
  const unlocked = accepted
    ? tasks.filter((task) => task.spawningDecisionIds?.includes(id) && task.coordinationStatus === "planned")
    : [];
  if (read.isError || graph.isError)
    return (
      <p role="alert" className="ui-meta text-danger">
        {read.error?.message ?? graph.error?.message}
      </p>
    );
  if (!decision)
    return (
      <p role="status" className="ui-meta">
        {t("views.decisionDetailView.bodyLoading")}
      </p>
    );
  return (
    <div className="min-w-0" data-testid="agenda-decision-actions">
      <DecisionJudgmentPanel
        decision={decision}
        relations={graph.relations}
        acceptBlockedReason={reviewAcceptBlockedReason(decision.review)}
        feedback={actions.feedback.get(id)}
        onCheckReceipt={() => void actions.checkReceipt(id)}
        onSubmit={async (value, action, input) => {
          onRetain();
          const result = await actions.judge(value, action, input);
          if (result.state === "success" && action === "accept") setAccepted(true);
          return result;
        }}
      />
      {unlocked.length > 0 && (
        <div className="grid gap-2 pt-3" data-testid="agenda-unlocked-tasks">
          {unlocked.map((task) => (
            <div key={task.taskId} className="flex min-w-0 flex-wrap items-center gap-2">
              <EntityRefLink entityRef={`task/${task.taskId}`} onNavigate={onNavigateEntity}>
                {task.title}
              </EntityRefLink>
              <Button
                size="sm"
                testId={`agenda-unlock-${task.taskId}`}
                loading={continuation.busy}
                onClick={() => {
                  setChildId(task.taskId);
                  void continuation.run(undefined, task.taskId);
                }}
              >
                {t("views.agenda.dispatchUnlocked")}
              </Button>
            </div>
          ))}
        </div>
      )}
      <AgendaContinuationFeedback
        continuation={continuation}
        onNavigateEntity={onNavigateEntity}
        onRetry={() => void continuation.run(undefined, childId)}
      />
    </div>
  );
}
