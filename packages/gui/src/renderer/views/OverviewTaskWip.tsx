import { useMemo } from "react";
import type { TaskWipRead } from "../../api/renderer-dto.ts";
import { EntityRefLink } from "../components/EntityRefLink.tsx";
import { STATUS_META } from "../components/badges";
import { DenseRow } from "../components/primitives/DenseRow";
import { Empty } from "../components/primitives/Empty";
import { Notice } from "../components/primitives/Notice";
import { SegCtl } from "../components/primitives/SegCtl";
import { StatusTag } from "../components/primitives/StatusTag";
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

/** 放大层的过滤态:分组 + 搜索。由宿主持有——键盘导航的可见集合必须与它是同一份。 */
export interface WipFilter {
  readonly group: WipGroup;
  readonly search: string;
}

/**
 * 过滤后的可见占位集合(名单渲染与键盘导航共用):分组命中的状态、标题/ID 命中搜索词,
 * 按状态生命周期序排列。抽成纯函数是为了让 FocusLayer 的 ↑↓ 只在「当前真正可见的行」
 * 里移动——itemIds 用全量 counted 时,被过滤隐藏的行仍可被键盘选中。
 */
export function wipVisibleEntries(counted: readonly TaskWipEntry[] | undefined, filter: WipFilter): TaskWipEntry[] {
  const needle = filter.search.trim().toLowerCase();
  return (counted ?? [])
    .filter(
      (entry) =>
        (filter.group === "all" || entry.status === filter.group) &&
        (needle === "" || entry.title.toLowerCase().includes(needle) || entry.taskId.toLowerCase().includes(needle)),
    )
    .sort((left, right) => WIP_STATUS_ORDER.indexOf(left.status) - WIP_STATUS_ORDER.indexOf(right.status));
}

/**
 * 总览「进行中的任务 / WIP」区域行体:占用数/上限在区域标题行(Region 的 big),根容器
 * 排除说明在区域页脚,本组件只装行体。数据只有一份——宿主把 `repo.tasks.wip` 的同一条
 * 快照连 loading/error 状态一起喂进来(总览/看板共用 `useTaskWipQuery`,台账切面前进时
 * 由既有失效扇出更新),组件不另发第二个查询、不在 GUI 侧重算准入。分组/搜索的过滤态也
 * 由宿主持有并经 `filter`/`onFilterChange` 传入:放大层的键盘导航按 `wipVisibleEntries`
 * 的可见集合移动,名单渲染与 itemIds 必须出自同一份过滤态:
 *
 * - 条面(inFocus=false):四个占位状态各计数(与评审区的分组计数条同构)+ 全量名单,
 *   行点击进放大层;根容器(declared/derived)与 planned 不占位,不进名单;
 * - 放大层(inFocus=true):状态分组按钮(带计数)+ 搜索接管过滤,行点击选中,详情
 *   侧给动作;行右侧实体引用两展面都直接导航(EntityRefLink,G-10);
 * - 名单内部限高滚动(Region 行体滚动容器),不截断行数;
 * - loading / error 是真实的 pending 与失败面,不冒充 0;空态只在 counted 为空时出现
 *   并如实带上当时的上限。
 */
export function OverviewTaskWipBody({
  snapshot,
  loading = false,
  error = null,
  selectedId = null,
  onSelect,
  onOpenTask,
  inFocus = false,
  filter,
  onFilterChange,
}: {
  /** `repo.tasks.wip` 的当前快照;数量与列表全部由它派生。 */
  readonly snapshot: TaskWipRead | undefined;
  /** 首次取数进行中(宿主传 `query.isPending`);已有旧快照时不闪 pending。 */
  readonly loading?: boolean;
  /** 取数失败的可读信息(宿主传 `query.error?.message ?? null`)。 */
  readonly error?: string | null;
  /** 放大层里的选中行(条面恒 null);由宿主持有,↑↓ 键在可见集合中移动。 */
  readonly selectedId?: string | null;
  /** 行主点击面:条面打开放大层并选中该行,放大层里更新选中。 */
  readonly onSelect: (taskId: string) => void;
  /** 行右侧实体引用的导航出口(App 的 openTaskDetail 同一落点)。 */
  readonly onOpenTask: (taskId: string) => void;
  /** 放大层展面:控制行(分组/搜索)替换条面的计数带。 */
  readonly inFocus?: boolean;
  /** 分组+搜索的过滤态(宿主持有):名单渲染与键盘导航的可见集合必须是同一份。 */
  readonly filter: WipFilter;
  readonly onFilterChange: (filter: WipFilter) => void;
}) {
  const counted = snapshot?.counted;

  const counts = useMemo(() => {
    const byStatus = new Map<TaskWipStatus, number>(WIP_STATUS_ORDER.map((status) => [status, 0]));
    for (const entry of counted ?? []) byStatus.set(entry.status, (byStatus.get(entry.status) ?? 0) + 1);
    return byStatus;
  }, [counted]);

  // 条面永远是全量名单(任务契约):过滤是放大层控制行的能力,关层不把过滤遗留到条面——
  // 否则条面显示不出为什么少了几行,看起来像数据丢了。
  const rows = useMemo(
    () => wipVisibleEntries(counted, inFocus ? filter : { group: "all", search: "" }),
    [counted, inFocus, filter],
  );

  const total = counted?.length ?? 0;

  return (
    <div data-testid="overview-task-wip" className="flex h-full min-h-0 min-w-0 flex-col">
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
          {inFocus ? (
            <div className="flex flex-none flex-wrap items-center gap-2 border-b border-border px-3.5 pb-2 pt-1">
              <SegCtl
                value={filter.group}
                onChange={(group) => onFilterChange({ ...filter, group })}
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
                value={filter.search}
                onChange={(search) => onFilterChange({ ...filter, search })}
                label={t("views.overviewTaskWip.searchLabel")}
                placeholder={t("views.overviewTaskWip.searchPlaceholder")}
                testId="overview-task-wip-search"
              />
            </div>
          ) : (
            // 四状态计数带与评审区的分组计数条同构(原型 .flow):数字 + 词表标签。
            <div className="grid flex-none grid-cols-4 gap-1 border-b border-border px-3.5 pb-1.5 pt-2">
              {WIP_STATUS_ORDER.map((status) => (
                <div key={status} className="min-w-0 text-center">
                  <span className="block font-mono font-semibold leading-none tabular-nums text-text ui-heading">
                    {counts.get(status) ?? 0}
                  </span>
                  <span className="block truncate text-text-faint ui-micro">{STATUS_META[status].label}</span>
                </div>
              ))}
            </div>
          )}
          <div data-testid="overview-task-wip-list" className="min-h-0 flex-1 overflow-y-auto">
            {rows.length === 0 ? (
              <div className="px-3.5 py-2">
                <Empty>
                  {filter.search.trim() !== ""
                    ? t("views.overviewTaskWip.emptySearch", { query: filter.search.trim() })
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
                  selected={selectedId === entry.taskId}
                  onClick={() => onSelect(entry.taskId)}
                />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
