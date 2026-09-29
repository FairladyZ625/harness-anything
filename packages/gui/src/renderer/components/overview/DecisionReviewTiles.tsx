import type { AgendaSuccess } from "../../api-client.ts";
import type { MessageKey } from "../../i18n/core.ts";
import { t } from "../../i18n/index.tsx";
import {
  decisionAgendaCounts,
  decisionAgendaRows,
  decisionTileTarget,
  taskAwaitsRows,
  type DecisionReviewGroup,
  type DecisionTileTarget,
} from "../../model/decision-review.ts";

const TILES: readonly (readonly [DecisionReviewGroup, MessageKey])[] = [
  ["dispose", "views.overviewView.decisionTileDispose"],
  ["review", "views.overviewView.decisionTileReview"],
  ["reviewing", "views.overviewView.decisionTileReviewing"],
  ["judge", "views.overviewView.decisionTileJudge"],
];

/**
 * 总览四格(原型 S1):待处置 / 待评审 / 评审中 / 待裁决(待处置含 task 源等你处理)。计数取总览已挂载的同一条议程读面,
 * 不另发请求;议程没读到或还在追赶时不给数字,不把半个切面冒充总数。点击按格分流(decisionTileTarget)。
 */
export function DecisionReviewTiles({
  agenda,
  onOpen,
}: {
  agenda: AgendaSuccess | undefined;
  onOpen: (target: DecisionTileTarget) => void;
}) {
  const ready = agenda?.status === "ready" ? agenda : null;
  const counts = ready ? decisionAgendaCounts(ready) : null;
  // 追赶中的半个切面不拿来直达单条:rows 为空时各格落到议程页 / 会话页。
  const rows = ready ? decisionAgendaRows(ready) : [];
  const taskAwaits = ready ? taskAwaitsRows(ready).length : 0;
  return (
    <div className="space-y-1" data-testid="overview-decision-tiles">
      <div
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
        role="group"
        aria-label={t("views.overviewView.decisionTilesLabel")}
      >
        {TILES.map(([group, label]) => (
          <button
            key={group}
            type="button"
            data-testid={`overview-decision-tile-${group}`}
            onClick={() => onOpen(decisionTileTarget(group, rows, taskAwaits))}
            className="rounded-md border border-border bg-surface-raised px-3 py-2 text-left transition-colors duration-150 hover:border-accent/60"
          >
            <span className="block font-mono text-xl font-semibold tabular-nums text-text">
              {counts === null ? "—" : counts[group]}
            </span>{" "}
            <span className="block ui-meta text-text-muted">{t(label)} →</span>
          </button>
        ))}
      </div>
      {agenda?.status === "pending" ? (
        <p className="font-mono ui-micro text-text-faint">
          {t("views.overviewView.decisionTilesCatchingUp", { revision: String(agenda.sourceRevision) })}
        </p>
      ) : null}
    </div>
  );
}
