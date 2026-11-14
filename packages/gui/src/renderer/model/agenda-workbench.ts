import type { AgendaSuccess, TaskListSuccess } from "../api-client.ts";
import { t } from "../i18n/index.tsx";
import { agendaRowsOf, GROUP_BUCKET, GROUP_ORDER, type AgendaRow } from "./agenda-rows.ts";
import type { AgendaAwaitsRow } from "../../api/renderer-dto.ts";
import type { TaskRow } from "./types.ts";

export type AgendaBucket = "inbox" | "outbox" | "follow";
export type AgendaWorkbenchFilter = AgendaBucket | "all";
type AttentionItem = AgendaSuccess["attentionItems"][number];

export interface AgendaWorkbenchItem {
  readonly key: string;
  readonly row: AgendaRow;
  readonly bucket: AgendaBucket;
  readonly quiet: boolean;
  readonly taskId: string | null;
  readonly task?: TaskRow;
  readonly attention?: AttentionItem["attention"];
  readonly workRootId: string | null;
  readonly asks: readonly AgendaAwaitsRow[];
}

const BUCKET_ORDER = { inbox: 0, outbox: 1, follow: 2 };
const GROUP_RANK = new Map(GROUP_ORDER.map((group, rank) => [group, rank]));
const RECENT_DELIVERY_MS = 7 * 24 * 60 * 60 * 1_000;

/** Presentation join only: daemon owns score, reasons, statuses and Work membership. */
export function agendaWorkbenchOf(
  agenda: AgendaSuccess,
  taskRead: TaskListSuccess | undefined,
  tasks: readonly TaskRow[],
  now: number,
): readonly AgendaWorkbenchItem[] {
  const attention = new Map(agenda.attentionItems.map((item) => [item.ref, item]));
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const workByTask = new Map(
    [
      ...agenda.inFlight,
      ...agenda.awaitingRestart,
      ...agenda.awaitingRework,
      ...agenda.awaitingAdjudication,
      ...agenda.underReview,
    ].map((row) => [row.taskId, row.work?.taskId]),
  );
  const asksBySource = new Map<string, AgendaAwaitsRow[]>();
  for (const ask of agenda.awaitingYou) {
    const asks = asksBySource.get(ask.sourceRef) ?? [];
    asks.push(ask);
    asksBySource.set(ask.sourceRef, asks);
  }
  const items = agendaRowsOf(agenda).map((row): AgendaWorkbenchItem => {
    const taskId = /^task(?:review)?\/([^/]+)/u.exec(row.target ?? "")?.[1] ?? null;
    const task = taskId === null ? undefined : taskById.get(taskId);
    // Native Decision rows retain their exact review route and expose each awaits inline.
    const asks = row.ask ? [row.ask] : row.group === "dispose" ? (asksBySource.get(`decision/${row.id}`) ?? []) : [];
    const source =
      (row.scoreRef === null ? undefined : attention.get(row.scoreRef)) ??
      asks
        .map((ask) => attention.get(`relation/${ask.relationId}`))
        .filter((item): item is AttentionItem => item !== undefined)
        .sort((a, b) => b.attention.score - a.attention.score)[0];
    return {
      key: `${row.group}:${row.id}`,
      row,
      bucket: row.group === "legacySubmitted" ? "outbox" : GROUP_BUCKET[row.group] === "attn" ? "inbox" : "follow",
      quiet: row.group === "answered",
      taskId,
      task,
      asks,
      attention: source?.attention,
      workRootId: source?.workTaskId ?? (taskId === null ? null : workByTask.get(taskId)) ?? task?.workId ?? null,
    };
  });
  // Existing agenda intent wins (restart/rework, adjudication, review follow-up); no duplicate task rows.
  const represented = new Set(items.map((item) => item.taskId));
  for (const projection of taskRead?.rows ?? []) {
    const task = taskById.get(projection.taskId);
    if (!task || represented.has(task.taskId) || task.packageDisposition !== "active") continue;
    const completedAt = projection.completedAt === null ? NaN : Date.parse(projection.completedAt);
    const recent = completedAt <= now && completedAt >= now - RECENT_DELIVERY_MS;
    if (
      task.coordinationStatus !== "submitted" &&
      task.coordinationStatus !== "in_review" &&
      !(task.coordinationStatus === "done" && recent)
    )
      continue;
    const ref = `task/${task.taskId}`;
    const source = attention.get(ref);
    items.push({
      key: `delivery:${task.taskId}`,
      bucket: "outbox",
      quiet: false,
      taskId: task.taskId,
      task,
      asks: [],
      attention: source?.attention,
      workRootId: source?.workTaskId ?? task.workId ?? null,
      row: {
        id: task.taskId,
        group: "legacySubmitted",
        title: task.title,
        hint: t("views.agenda.filterOutbox"),
        since: projection.completedAt ?? projection.updatedAt,
        scoreRef: ref,
        target: `taskreview/${task.taskId}`,
      },
    });
  }
  return items.sort(
    (a, b) =>
      BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket] ||
      (b.attention?.score ?? -1) - (a.attention?.score ?? -1) ||
      (GROUP_RANK.get(a.row.group) ?? 0) - (GROUP_RANK.get(b.row.group) ?? 0),
  );
}
