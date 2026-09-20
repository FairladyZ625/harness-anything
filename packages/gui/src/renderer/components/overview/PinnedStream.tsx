import {
  BookOpen,
  CheckSquare,
  Clock,
  File,
  Info,
  Pause,
  Play,
  PlugsConnected,
  PushPin,
  Robot,
  Scales,
  Stack,
  Users,
  Waveform,
} from "@phosphor-icons/react";
import { useMemo, type ReactNode } from "react";
import type { DecisionState, SnapshotStatus, TaskRow } from "../../model/types";
import { DecisionStateBadge, isDecisionState, StatusBadge } from "../badges.tsx";
import { t, type MessageKey } from "../../i18n/index.tsx";
import { StreamBody, StreamEmpty, streamTime } from "./streamParts.tsx";
import { entityDetailTargetOf } from "../../navigation/entityRoutes.ts";
import type { AgendaSuccess } from "../../api-client.ts";

export interface PinnedAgendaItem {
  /** canonical 实体引用(task 行补成 task/<id>),行主键与导航输入共用。 */
  readonly ref: string;
  readonly kind: string;
  readonly taskId?: string;
  readonly title: string;
  /** 该 kind 自己的状态词:task 是 SnapshotStatus,decision 是决策态,schedule 是 armed/paused;
   * 词表外的词按原文显示。 */
  readonly status: string;
  readonly updatedAt: string;
}

const PINNED_ROW_CLASS_NAME = [
  "flex items-center gap-2 rounded-md border border-border bg-accent-fg/40 px-2 py-1",
  "[contain-intrinsic-size:auto_1.75rem] [content-visibility:auto] hover:border-accent/60",
].join(" ");

const PINNED_ROW_BODY_CLASS_NAME = "flex min-w-0 flex-1 items-center gap-2 text-left";

const PIN_TOGGLE_CLASS_NAME = [
  "inline-flex shrink-0 items-center justify-center rounded p-0.5 ui-body",
  "text-accent hover:bg-surface",
].join(" ");

/** kind 徽标:图标 + i18n 文字,颜色只作辅助区分(色弱可读,文字始终在场)。 */
const PINNED_KIND_META: Record<string, { readonly key: MessageKey; readonly color: string; readonly icon: ReactNode }> =
  {
    task: {
      key: "views.overviewView.pinKind.task",
      color: "var(--color-status-active)",
      icon: <CheckSquare weight="bold" />,
    },
    decision: {
      key: "views.overviewView.pinKind.decision",
      color: "var(--color-status-in-review)",
      icon: <Scales weight="bold" />,
    },
    schedule: {
      key: "views.overviewView.pinKind.schedule",
      color: "var(--color-stale)",
      icon: <Clock weight="bold" />,
    },
    fact: {
      key: "views.overviewView.pinKind.fact",
      color: "var(--color-status-done)",
      icon: <Info weight="bold" />,
    },
    agent: {
      key: "views.overviewView.pinKind.agent",
      color: "var(--color-status-planned)",
      icon: <Robot weight="bold" />,
    },
    squad: {
      key: "views.overviewView.pinKind.squad",
      color: "var(--color-status-planned)",
      icon: <Users weight="bold" />,
    },
    provider: {
      key: "views.overviewView.pinKind.provider",
      color: "var(--color-status-cancelled)",
      icon: <PlugsConnected weight="bold" />,
    },
    session: {
      key: "views.overviewView.pinKind.session",
      color: "var(--color-status-cancelled)",
      icon: <Waveform weight="bold" />,
    },
    preset: {
      key: "views.overviewView.pinKind.preset",
      color: "var(--color-status-cancelled)",
      icon: <Stack weight="bold" />,
    },
    entitydoc: {
      key: "views.overviewView.pinKind.entity",
      color: "var(--color-text-muted)",
      icon: <BookOpen weight="bold" />,
    },
  };

/** 非任务 kind 的状态词表集中在此:daemon 给什么词就解什么词,词表外的按原文显示。 */
const PINNED_ENTITY_STATUS: Record<
  string,
  Record<string, { readonly key: MessageKey; readonly color: string; readonly icon: ReactNode }>
> = {
  schedule: {
    armed: {
      key: "schedules.state.armed",
      color: "var(--color-status-active)",
      icon: <Play weight="bold" />,
    },
    paused: {
      key: "schedules.state.paused",
      color: "var(--color-status-in-review)",
      icon: <Pause weight="bold" />,
    },
  },
};

/**
 * `repo.agenda.read` 的 pinned-first 四组收拢为一个 task 集。active task 可能同时
 * 出现在「在飞」和「球在别人手里」,所以按实体 ref 去重;待派审/评审中的 execution
 * 还原为其所属 task,状态取各自分组的 task 状态。排序只用投影携带的时间,不依赖
 * 尚未水化完的 task list。
 */
export function pinnedAgendaItems(agenda: AgendaSuccess): readonly PinnedAgendaItem[] {
  const rows = new Map<string, PinnedAgendaItem>();
  const accept = (item: PinnedAgendaItem) => {
    const current = rows.get(item.ref);
    if (!current || item.updatedAt > current.updatedAt) rows.set(item.ref, item);
  };
  for (const group of [agenda.inFlight, agenda.waitingOnOthers, agenda.dispatchable]) {
    for (const row of group) {
      if (row.pinned !== true) continue;
      accept({
        ref: `task/${row.taskId}`,
        kind: "task",
        taskId: row.taskId,
        title: row.title,
        status: row.status,
        updatedAt: row.updatedAt,
      });
    }
  }
  for (const [group, status] of [
    [agenda.awaitingAdjudication, "submitted"],
    [agenda.underReview, "in_review"],
  ] as const) {
    for (const row of group) {
      if (row.pinned !== true) continue;
      accept({
        ref: `task/${row.taskId}`,
        kind: "task",
        taskId: row.taskId,
        title: row.title,
        status,
        updatedAt: row.submittedAt,
      });
    }
  }
  for (const row of agenda.pinnedEntities) {
    if (row.kind === "task") continue;
    accept({ ref: row.ref, kind: row.kind, title: row.title, status: row.status, updatedAt: row.pinnedAt });
  }
  return [...rows.values()].sort(
    (left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.ref.localeCompare(left.ref),
  );
}

function PinnedKindBadge({ kind }: { readonly kind: string }) {
  const meta = PINNED_KIND_META[kind];
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-px font-mono ui-micro"
      style={{ color: meta?.color ?? "var(--color-text-muted)" }}
      data-testid={`pinned-kind-${kind}`}
    >
      <span className="ui-micro">{meta?.icon ?? <File weight="bold" />}</span>
      {meta ? t(meta.key) : kind}
    </span>
  );
}

function PinnedStatusChip({ item }: { readonly item: PinnedAgendaItem }) {
  if (item.kind === "task") return <StatusBadge status={item.status as SnapshotStatus} />;
  if (item.kind === "decision" && isDecisionState(item.status))
    return <DecisionStateBadge state={item.status as DecisionState} />;
  const meta = PINNED_ENTITY_STATUS[item.kind]?.[item.status];
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 ui-body font-medium"
      style={{
        color: meta?.color ?? "var(--color-text-muted)",
        background: `color-mix(in oklch, ${meta?.color ?? "var(--color-text-muted)"} 12%, transparent)`,
      }}
    >
      {meta ? <span className="ui-body">{meta.icon}</span> : null}
      {meta ? t(meta.key) : item.status}
    </span>
  );
}

/**
 * 总览「置顶」直接使用 `ha agenda` 的 `repo.agenda.read` 结果,而不是等待
 * repo.tasks.list 的 cursor 水化走到碰巧包含 pinned task 的页。pin 与「进行中」
 * 正交:进行中未必置顶,置顶未必进行中;置顶成员也不限于 task,任意实体 ref 都行。
 *
 * 不分批(判据,留给下一个人核对):本流成员的唯一来源是「被人手动 pin 过」,
 * 每一行都是一次显式的人为动作,unpin 即移除;规模由人的当前关注集决定,
 * 不会仅因历史台账增长而增长。
 * 全站已不再用「再显示」分批(2026-08-25 泽宇裁决):行集增长也走完整渲染 +
 * content-visibility,按 TaskStream 同款类名即可。
 */
export function PinnedStream({
  agenda,
  onOpenPreview,
  onNavigateEntity,
  declaredKinds = [],
  onSetPin,
}: {
  agenda: AgendaSuccess | undefined;
  onOpenPreview: (taskId: string) => void;
  /** 非任务实体的导航出口;行是否可点由 entityRoutes 的可寻址表决定,
   * 没有去处的 kind 不渲染成按钮。 */
  onNavigateEntity?: (ref: string) => void;
  /** 已注册 kind 读面(entityRoutes 的 declaredKinds):声明实体的 ref 靠它判定落点。 */
  declaredKinds?: readonly string[];
  onSetPin?: (task: Pick<TaskRow, "taskId">, pinned: boolean) => void;
}) {
  const rows = useMemo(() => (agenda ? pinnedAgendaItems(agenda) : []), [agenda]);

  if (!agenda) return <StreamEmpty>{t("views.overviewView.pinnedLoading")}</StreamEmpty>;

  if (rows.length === 0) {
    return (
      <StreamEmpty>
        {t("views.overviewView.pinnedEmpty")}{" "}
        <span className="font-mono ui-meta text-text-faint">{t("views.overviewView.pinnedHint")}</span>
      </StreamEmpty>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <p className="shrink-0 font-mono ui-micro text-text-faint" data-testid="pinned-projection-cut">
        {t("views.overviewView.pinnedProjection", {
          count: rows.length,
          watermark: String(agenda.watermark),
        })}
      </p>
      <StreamBody testId="pinned-stream-rows">
        {rows.map((item) => {
          const onOpen =
            item.kind === "task" && item.taskId !== undefined
              ? () => onOpenPreview(item.taskId!)
              : onNavigateEntity !== undefined && entityDetailTargetOf(item.ref, declaredKinds) !== null
                ? () => onNavigateEntity(item.ref)
                : null;
          const body = (
            <>
              <PinnedKindBadge kind={item.kind} />
              <span className="min-w-0 flex-1 truncate ui-body font-medium text-text">{item.title}</span>
              <PinnedStatusChip item={item} />
              <span className="shrink-0 font-mono ui-micro tabular-nums text-text-faint">
                {streamTime(item.updatedAt)}
              </span>
            </>
          );
          return (
            <div key={item.ref} className={PINNED_ROW_CLASS_NAME}>
              {onOpen === null ? (
                <div title={`${item.ref} · ${item.title}`} className={PINNED_ROW_BODY_CLASS_NAME}>
                  {body}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={onOpen}
                  title={`${item.ref} · ${item.title}`}
                  className={PINNED_ROW_BODY_CLASS_NAME}
                >
                  {body}
                </button>
              )}
              {onSetPin && item.kind === "task" && item.taskId !== undefined ? (
                <button
                  type="button"
                  data-testid={`overview-pin-toggle-${item.taskId}`}
                  onClick={() => onSetPin({ taskId: item.taskId! }, false)}
                  aria-pressed="true"
                  title={t("views.overviewView.unpinTitle")}
                  className={PIN_TOGGLE_CLASS_NAME}
                >
                  <PushPin weight="fill" />
                </button>
              ) : (
                <PushPin
                  weight="fill"
                  className="shrink-0 ui-body text-accent"
                  aria-label={t("views.overviewView.unpinViaCli", { ref: item.ref })}
                />
              )}
            </div>
          );
        })}
      </StreamBody>
      {agenda.pinnedEntityOverflow > 0 ? (
        <p className="shrink-0 font-mono ui-micro text-text-faint" data-testid="pinned-entity-overflow">
          {t("views.overviewView.pinnedOverflow", { count: agenda.pinnedEntityOverflow })}
        </p>
      ) : null}
    </div>
  );
}
