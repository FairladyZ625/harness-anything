import { useMemo, useState } from "react";
import type { TaskWipRead } from "../../api/renderer-dto.ts";
import { EntityRefLink } from "../components/EntityRefLink.tsx";
import { STATUS_META } from "../components/badges";
import { DenseRow } from "../components/primitives/DenseRow";
import { Empty } from "../components/primitives/Empty";
import { Notice } from "../components/primitives/Notice";
import { SegCtl } from "../components/primitives/SegCtl";
import { StatusTag, TONE_COLOR } from "../components/primitives/StatusTag";
import { TextInput } from "../components/primitives/TextInput";
import { t } from "../i18n/index.tsx";

/** daemon WIP 快照的一行占位(repo.tasks.wip 的 counted 项):taskId/title/status。 */
type TaskWipEntry = TaskWipRead["counted"][number];
type TaskWipStatus = TaskWipEntry["status"];

/**
 * 过滤组的展示序与「零计数也可见」的成员集:成员由线上的 TaskWipStatus 词表在编译期
 * 钉死(satisfies),kernel 的占位状态集变化时这里必须跟着改,不允许静默漂移。顺序沿用
 * GUI 状态分段条(SEGMENT_ORDER)的生命周期序,不引入 kernel 的建议排序。
 */
const WIP_STATUS_ORDER = ["active", "submitted", "in_review", "blocked"] as const satisfies readonly TaskWipStatus[];

type WipGroup = "all" | TaskWipStatus;

function statusRank(status: TaskWipStatus): number {
  return WIP_STATUS_ORDER.indexOf(status);
}

/**
 * 总览「进行中的任务 / WIP」业务组件:显示真实占用数与当前上限、各占位状态的数量与
 * 可过滤的完整名单。数据只有一份——宿主把 `repo.tasks.wip` 的同一条快照连 loading/error
 * 状态一起喂进来(App 侧 `useTaskWipQuery`,台账切面前进时由既有失效扇出更新),组件
 * 不另发第二个查询、不在 GUI 侧重算准入:
 *
 * - 占用 = `counted.length`,上限 = `snapshot.limit`(来源 `limitLabel`),不写死 30;
 * - 根容器(declared/derived)与 planned 不占位:它们只在页脚作排除说明,不混入分母;
 * - 每行状态 + 标题 + 可点导航,行右侧的实体引用走 EntityRefLink(G-10),两条路都接
 *   宿主的 `onOpenTask`;
 * - 列表在组件内部限高滚动(共享 `--long-content-cap`),搜索按标题或任务 ID 过滤,
 *   状态分组按钮切换名单,「全部」恢复全量;
 * - loading / error 是真实的 pending 与失败面,不冒充 0;空态只在该快照 counted 为
 *   空时出现,并如实带上当时的上限。
 */
export function OverviewTaskWip({
  snapshot,
  loading = false,
  error = null,
  onOpenTask,
}: {
  /** `repo.tasks.wip` 的当前快照;数量与列表全部由它派生。 */
  readonly snapshot: TaskWipRead | undefined;
  /** 首次取数进行中(宿主传 `query.isPending`);已有旧快照时不闪 pending。 */
  readonly loading?: boolean;
  /** 取数失败的可读信息(宿主传 `query.error?.message ?? null`)。 */
  readonly error?: string | null;
  /** 行与实体引用共用的导航出口(App 的 openTaskDetail 同一落点)。 */
  readonly onOpenTask: (taskId: string) => void;
}) {
  const [group, setGroup] = useState<WipGroup>("all");
  const [search, setSearch] = useState("");
  const counted = snapshot?.counted;
  const roots = snapshot?.roots;

  const counts = useMemo(() => {
    const byStatus = new Map<TaskWipStatus, number>(WIP_STATUS_ORDER.map((status) => [status, 0]));
    for (const entry of counted ?? []) byStatus.set(entry.status, (byStatus.get(entry.status) ?? 0) + 1);
    return byStatus;
  }, [counted]);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (counted ?? [])
      .filter(
        (entry) =>
          (group === "all" || entry.status === group) &&
          (needle === "" || entry.title.toLowerCase().includes(needle) || entry.taskId.toLowerCase().includes(needle)),
      )
      .sort((left, right) => statusRank(left.status) - statusRank(right.status));
  }, [counted, group, search]);

  const total = counted?.length ?? 0;
  const full = snapshot !== undefined && total >= snapshot.limit;
  // 快照未到时占用值不是 0:取数中给 pending 记号,失败给破折号,数字只在有快照时出现。
  const occupancy = snapshot === undefined ? (error !== null ? "—" : "…") : `${total}/${snapshot.limit}`;
  const declared = roots?.filter((root) => root.reason === "declared") ?? [];
  const derived = roots?.filter((root) => root.reason === "derived") ?? [];

  return (
    <section
      data-testid="overview-task-wip"
      aria-label={t("views.overviewTaskWip.title")}
      className="flex h-full max-h-[var(--long-content-cap)] min-h-0 min-w-0 flex-col"
    >
      <header className="flex flex-none flex-wrap items-center gap-x-2 gap-y-1 px-3.5 pb-1.5 pt-2.5">
        <h3 className="min-w-0 truncate font-semibold ui-meta">{t("views.overviewTaskWip.title")}</h3>
        {full && <StatusTag tone="bad" label={t("views.overviewTaskWip.fullTag")} />}
        <span
          data-testid="overview-task-wip-occupancy"
          data-full={full || undefined}
          title={
            snapshot === undefined
              ? undefined
              : t("views.overviewTaskWip.occupancyTitle", {
                  count: total,
                  limit: snapshot.limit,
                  limitLabel: snapshot.limitLabel,
                  threshold: snapshot.threshold,
                })
          }
          className="ml-auto font-mono font-semibold leading-none tabular-nums ui-heading"
          style={full ? { color: TONE_COLOR.bad } : undefined}
        >
          {occupancy}
        </span>
      </header>
      {error !== null && (
        <Notice tone="bad" variant="strip" testId="overview-task-wip-error">
          {snapshot === undefined
            ? `${t("views.overviewTaskWip.errorRead")} ${error}`
            : `${t("views.overviewTaskWip.errorStale")} ${error}`}
        </Notice>
      )}
      {snapshot === undefined ? (
        loading ? (
          <p data-testid="overview-task-wip-loading" className="px-3.5 py-2 ui-meta text-text-faint">
            {t("views.overviewTaskWip.loading")}
          </p>
        ) : null
      ) : total === 0 ? (
        <div data-testid="overview-task-wip-empty" className="px-3.5 pb-2">
          <Empty>{t("views.overviewTaskWip.emptyIdle")}</Empty>
          <Empty>
            {t("views.overviewTaskWip.emptyLimit", { limit: snapshot.limit, limitLabel: snapshot.limitLabel })}
          </Empty>
        </div>
      ) : (
        <>
          <div className="flex flex-none flex-wrap items-center gap-2 border-b border-border px-3.5 pb-2 pt-1">
            <SegCtl
              value={group}
              onChange={setGroup}
              label={t("views.overviewTaskWip.filterLabel")}
              options={[
                { value: "all" as const, label: `${t("views.overviewTaskWip.filterAll")} ${total}` },
                ...WIP_STATUS_ORDER.map((status) => ({
                  value: status,
                  label: `${STATUS_META[status].label} ${counts.get(status) ?? 0}`,
                })),
              ]}
            />
            <TextInput
              value={search}
              onChange={setSearch}
              label={t("views.overviewTaskWip.searchLabel")}
              placeholder={t("views.overviewTaskWip.searchPlaceholder")}
              testId="overview-task-wip-search"
            />
          </div>
          <div data-testid="overview-task-wip-list" className="min-h-0 flex-1 overflow-y-auto">
            {rows.length === 0 ? (
              <div className="px-3.5 py-2">
                <Empty>
                  {search.trim() !== ""
                    ? t("views.overviewTaskWip.emptySearch", { query: search.trim() })
                    : t("views.overviewTaskWip.emptyFilter")}
                </Empty>
              </div>
            ) : (
              rows.map((entry) => (
                <DenseRow
                  key={entry.taskId}
                  tag={<StatusTag status={entry.status} />}
                  title={entry.title}
                  hoverTitle={entry.taskId}
                  action={
                    <EntityRefLink
                      entityRef={`task/${entry.taskId}`}
                      onNavigate={() => onOpenTask(entry.taskId)}
                      title={entry.title === "" ? undefined : entry.title}
                      className="font-mono ui-micro text-accent hover:underline"
                    >
                      <span className="max-w-[18ch] truncate">{entry.taskId}</span>
                    </EntityRefLink>
                  }
                  onClick={() => onOpenTask(entry.taskId)}
                />
              ))
            )}
          </div>
        </>
      )}
      {snapshot !== undefined && (
        <footer
          data-testid="overview-task-wip-footer"
          title={t("views.overviewTaskWip.footerRootsTitle", {
            declaredIds: declared.map((root) => root.taskId).join(", ") || "none",
            derivedIds: derived.map((root) => `${root.taskId}(${root.directChildCount})`).join(", ") || "none",
            threshold: snapshot.threshold,
          })}
          className="flex-none truncate border-t border-border px-3.5 py-1.5 text-text-faint ui-micro"
        >
          {t("views.overviewTaskWip.footerRule", {
            roots: roots?.length ?? 0,
            declared: declared.length,
            derived: derived.length,
          })}
        </footer>
      )}
    </section>
  );
}
