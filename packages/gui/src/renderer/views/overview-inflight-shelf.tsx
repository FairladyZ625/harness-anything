import { useState } from "react";
import { ArrowSquareOut } from "@phosphor-icons/react";
import type { ArtifactGuiRowDto } from "@harness-anything/daemon/protocol";
import { DenseRow, RowTime } from "../components/primitives/DenseRow";
import { Empty } from "../components/primitives/Empty";
import { Notice } from "../components/primitives/Notice";
import { StatusTag } from "../components/primitives/StatusTag";
import { t } from "../i18n/index.tsx";
import { formatRelative, formatTime } from "../model/time.ts";
import { openArtifactExternally } from "../artifact-open-client.ts";
import { useRepoRow } from "../system-data.ts";
import { ARTIFACT_OPEN_BUTTON_CLASS, fileNameOf, repoPathOf } from "./ArtifactsView.tsx";
import type { InflightTaskRow, OverviewBoardDeps } from "./overview-model.ts";

/* ------------------------------------------------------------------ 左列:在飞任务流与产物速览架 */

/**
 * 在飞任务流的行体(task_8a83698):repo.tasks.wip 的 active/submitted/in_review 占位任务
 * 平铺在总览左列——状态标签 + 标题 + 执行者(live 会话,无会话如实标注)+ 最近活动的
 * 相对年龄,行点击直达任务详情。名单内部滚动(Region 行体滚动容器),blocked 不进流
 * (住「跟进与返工」),四态全量与过滤仍在 WIP 放大层。
 */
export function OverviewInflightBody({
  rows,
  loading = false,
  error = null,
  deps,
}: {
  /** inflightTaskRows 的当前行(wip × runtime × agenda 的同一份派生)。 */
  readonly rows: readonly InflightTaskRow[];
  /** WIP 读面首次取数进行中(宿主传 `query.isPending`);已有快照时不闪 pending。 */
  readonly loading?: boolean;
  /** WIP 读面失败的可读信息(宿主传 `query.error?.message ?? null`)。 */
  readonly error?: string | null;
  readonly deps: OverviewBoardDeps;
}) {
  if (error !== null) {
    return (
      <Notice tone="bad" variant="strip" testId="overview-inflight-error">
        {t("views.overviewView.inflightReadFailed", { error })}
      </Notice>
    );
  }
  if (rows.length === 0) {
    return loading ? (
      <p data-testid="overview-inflight-loading" className="px-3.5 py-2 ui-meta text-text-faint">
        {t("views.overviewTaskWip.loading")}
      </p>
    ) : (
      <div data-testid="overview-inflight-empty" className="px-3.5 py-2">
        <Empty>{t("views.overviewView.inflightEmpty")}</Empty>
      </div>
    );
  }
  return (
    <div data-testid="overview-inflight">
      {rows.map((row) => (
        <div key={row.taskId} data-inflight-task={row.taskId}>
          <DenseRow
            tag={<StatusTag status={row.status} />}
            title={row.title}
            hoverTitle={row.taskId}
            reason={
              row.handlers.length > 0 ? (
                row.handlers.join(" · ")
              ) : (
                <span className="text-status-submitted">{t("views.overviewView.worksNoAgent")}</span>
              )
            }
            time={
              row.since === null ? undefined : (
                <span
                  title={formatTime(row.since, { style: "date-time", now: deps.now }) ?? row.since}
                  className="whitespace-nowrap font-mono tabular-nums text-text-muted ui-meta"
                >
                  {formatRelative(row.since, { now: deps.now })}
                </span>
              )
            }
            onClick={() => deps.onOpenTask(row.taskId)}
          />
        </div>
      ))}
    </div>
  );
}

/** 速览架默认铺出的最新产物条数:速览不是时间线,更长名单走产物页。 */
export const ARTIFACTS_SHELF_LIMIT = 6;

/**
 * 最新 HTML 产物速览架(task_8a83698):一条 `repo.artifacts.list`(kind=html,与产物页
 * 同一缓存)取最新产物,平铺产物名、所属任务与创建时间;行右侧「在浏览器打开」走
 * openArtifactExternally 的 preload 通道(主进程校验),行点击跳所属任务。无归属任务、
 * 纯展示仓的禁用规则与产物页预览头同一份。
 */
export function OverviewArtifactsShelf({
  repoId,
  rows,
  total: _total,
  pending,
  error,
  onOpenTask,
  onOpenAll: _onOpenAll,
  deps: _deps,
}: {
  readonly repoId: string;
  /** daemon 已按时间倒序给出的 HTML 产物行(速览架只裁条数,不重排)。 */
  readonly rows: readonly ArtifactGuiRowDto[];
  /** 该 kind 的总数(读面 counts.html;区域标题的大数字)。 */
  readonly total: number;
  readonly pending: boolean;
  /** 取数失败的可读信息。 */
  readonly error: string | null;
  readonly onOpenTask: (taskId: string) => void;
  /** 「查看全部产物」的落点(产物页);未提供时不渲染该入口。 */
  readonly onOpenAll: (() => void) | undefined;
  readonly deps: OverviewBoardDeps;
}) {
  // 纯展示(remote-proxy)仓的「打开」走主进程物化副本统一面(与产物页同一判据)。
  const remoteProxy = useRepoRow(repoId)?.mode === "remote-proxy";
  const [openError, setOpenError] = useState<string | null>(null);
  const openExternally = async (row: ArtifactGuiRowDto) => {
    setOpenError(null);
    const outcome = await openArtifactExternally({
      repoId,
      path: repoPathOf(row),
      ...(row.taskId !== null ? { taskId: row.taskId } : {}),
    });
    if (outcome.error !== null) setOpenError(outcome.error);
  };
  const shown = rows.slice(0, ARTIFACTS_SHELF_LIMIT);
  return (
    <div data-testid="overview-artifacts-shelf" className="flex h-full min-h-0 min-w-0 flex-col">
      {error !== null ? (
        <Notice tone="bad" variant="strip" testId="overview-artifacts-error">
          {t("artifacts.readFailed", { error })}
        </Notice>
      ) : rows.length === 0 ? (
        <div data-testid="overview-artifacts-empty" className="px-3.5 py-2">
          <Empty>{pending ? t("artifacts.loading") : t("views.overviewView.artifactsShelfEmpty")}</Empty>
        </div>
      ) : (
        <>
          {shown.map((row) => (
            <div key={`${row.taskId ?? "taskless"}/${row.path}`} data-shelf-artifact={row.path}>
              <DenseRow
                tag={<StatusTag tone="neutral" label={t("artifacts.kind.html")} />}
                title={fileNameOf(row.path)}
                hoverTitle={repoPathOf(row)}
                reason={
                  row.taskId === null ? (
                    t("artifacts.taskUnknown")
                  ) : (
                    <span title={row.taskId}>{row.taskTitle ?? row.taskId}</span>
                  )
                }
                time={<RowTime at={row.time} className="ui-meta" />}
                action={
                  <button
                    type="button"
                    data-testid={`overview-artifact-open-${row.taskId ?? "taskless"}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void openExternally(row);
                    }}
                    disabled={row.packagePath === null || (remoteProxy && row.taskId === null)}
                    title={
                      row.packagePath === null
                        ? t("artifacts.preview.openExternalNoPackage")
                        : t("artifacts.preview.openExternalTitle")
                    }
                    aria-label={t("artifacts.preview.openExternalTitle")}
                    className={ARTIFACT_OPEN_BUTTON_CLASS}
                  >
                    <ArrowSquareOut className="size-3" />
                  </button>
                }
                onClick={row.taskId === null ? undefined : () => onOpenTask(row.taskId!)}
              />
            </div>
          ))}
          {openError !== null && (
            <p
              role="alert"
              data-testid="overview-artifacts-open-error"
              className="px-3.5 py-1.5 font-mono ui-micro text-status-blocked"
            >
              {openError}
            </p>
          )}
        </>
      )}
    </div>
  );
}
