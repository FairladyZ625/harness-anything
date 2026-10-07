import { useState } from "react";
import { ArrowSquareOut } from "@phosphor-icons/react";
import type { ArtifactGuiRowDto } from "@harness-anything/daemon/protocol";
import { DenseRow, RowTime } from "../components/primitives/DenseRow";
import { Empty } from "../components/primitives/Empty";
import { Notice } from "../components/primitives/Notice";
import { StatusTag } from "../components/primitives/StatusTag";
import { HtmlArtifactPreview } from "../components/HtmlArtifactPreview.tsx";
import { t } from "../i18n/index.tsx";
import { formatRelative, formatTime } from "../model/time.ts";
import { openArtifactExternally } from "../artifact-open-client.ts";
import { useRepoRow } from "../system-data.ts";
import { useTaskDocumentQuery } from "../task-data.ts";
import { ARTIFACT_OPEN_BUTTON_CLASS, fileNameOf, repoPathOf } from "./ArtifactsView.tsx";
import type { InflightTaskRow } from "./overview-model.ts";
import type { OverviewBoardDeps } from "./overview-regions.tsx";

/* ------------------------------------------------------------------ 左列:在飞任务流与产物速览架 */

/**
 * 在飞任务流的行体(task_8a83698):repo.tasks.wip 的 active/submitted/in_review 占位任务
 * 平铺在总览左列——状态标签 + 标题 + 执行者(live 会话,无会话如实标注)+ 最近活动的
 * 相对年龄,行点击直达任务详情。行取 relaxed 两行档(标题一行、执行者与年龄收进弱色
 * 第二行):左列是窄流,单行档会把执行者挤成中途截断。名单内部滚动(Region 行体滚动
 * 容器),blocked 不进流(住「跟进与返工」),四态全量与过滤仍在 WIP 放大层。
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
            relaxed
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

/** 产物行的稳定键(速览架/详情层/键盘导航同一份)。 */
export function artifactRowKey(row: ArtifactGuiRowDto): string {
  return `${row.taskId ?? "taskless"}/${row.path}`;
}

/**
 * 最新 HTML 产物速览架(task_8a83698;2026-10-07 三块区域返工):一条 `repo.artifacts.list`
 * (kind=html,与产物页同一缓存)取最新产物,平铺产物名、所属任务与创建时间;行右侧
 * 「在浏览器打开」走 openArtifactExternally 的 preload 通道(主进程校验),行点击弹
 * 产物详情层(OverviewView 的 FocusLayer + ArtifactFocusDetail)——不要求离开总览,
 * task_15b1bb96 的「点 HTML 产物直接打开该 HTML」语义在层内预览保持。无归属任务、
 * 纯展示仓的禁用规则与产物页预览头同一份。
 */
export function OverviewArtifactsShelf({
  repoId,
  rows,
  pending,
  error,
  onOpenArtifact,
}: {
  readonly repoId: string;
  /** daemon 已按时间倒序给出的 HTML 产物行(速览架只裁条数,不重排)。 */
  readonly rows: readonly ArtifactGuiRowDto[];
  readonly pending: boolean;
  /** 取数失败的可读信息。 */
  readonly error: string | null;
  /** 行点击的落点:弹产物详情层(键用 artifactRowKey,与层内列表/键盘导航同源)。 */
  readonly onOpenArtifact: (row: ArtifactGuiRowDto) => void;
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
            <div key={artifactRowKey(row)} data-shelf-artifact={row.path}>
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
                onClick={() => onOpenArtifact(row)}
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

/** 产物详情层左列表:与速览架同一排行(全部行,不只架上的 6 条)。 */
export function ArtifactFocusList({
  rows,
  selectedId,
  onSelect,
}: {
  readonly rows: readonly ArtifactGuiRowDto[];
  readonly selectedId: string | null;
  readonly onSelect: (key: string) => void;
}) {
  return (
    <>
      {rows.map((row) => (
        <DenseRow
          key={artifactRowKey(row)}
          tag={<StatusTag tone="neutral" label={t("artifacts.kind.html")} />}
          title={fileNameOf(row.path)}
          hoverTitle={repoPathOf(row)}
          reason={row.taskTitle ?? row.taskId ?? t("artifacts.taskUnknown")}
          time={<RowTime at={row.time} className="ui-meta" />}
          selected={selectedId === artifactRowKey(row)}
          onClick={() => onSelect(artifactRowKey(row))}
        />
      ))}
    </>
  );
}

/**
 * 产物详情层右栏(2026-10-07):层内直接渲染该 HTML 的隔离预览(HtmlArtifactPreview,
 * 脚本/外联禁用,与产物页同一渲染路径),「跳到所属 task」保留 task_15b1bb96 的落点
 * (进任务页并直接选中该产物文档),「在浏览器打开」与速览架行按钮同一 preload 通道。
 */
export function ArtifactFocusDetail({
  repoId,
  row,
  onOpenTask,
}: {
  readonly repoId: string;
  readonly row: ArtifactGuiRowDto;
  /** 「跳到所属 task」的落点:进任务页并直接选中该产物文档(包内相对路径)。 */
  readonly onOpenTask: (taskId: string, docPath: string) => void;
}) {
  const remoteProxy = useRepoRow(repoId)?.mode === "remote-proxy";
  const [openError, setOpenError] = useState<string | null>(null);
  const document = useTaskDocumentQuery(repoId, row.taskId ?? "", row.taskId === null ? null : row.path);
  const openExternally = async () => {
    setOpenError(null);
    const outcome = await openArtifactExternally({
      repoId,
      path: repoPathOf(row),
      ...(row.taskId !== null ? { taskId: row.taskId } : {}),
    });
    if (outcome.error !== null) setOpenError(outcome.error);
  };
  return (
    <div data-testid="overview-artifact-detail" className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-none flex-wrap items-center gap-2">
        <StatusTag tone="neutral" label={t("artifacts.kind.html")} />
        <h3 className="min-w-0 flex-1 truncate text-text ui-title" title={repoPathOf(row)}>
          {fileNameOf(row.path)}
        </h3>
        <button
          type="button"
          data-testid="overview-artifact-detail-open-external"
          onClick={() => void openExternally()}
          disabled={row.packagePath === null || (remoteProxy && row.taskId === null)}
          title={
            row.packagePath === null
              ? t("artifacts.preview.openExternalNoPackage")
              : t("artifacts.preview.openExternalTitle")
          }
          className={ARTIFACT_OPEN_BUTTON_CLASS}
        >
          <ArrowSquareOut className="size-3" />
          {t("artifacts.preview.openExternalTitle")}
        </button>
        {row.taskId !== null && (
          <button
            type="button"
            data-testid="overview-artifact-detail-open-task"
            onClick={() => onOpenTask(row.taskId!, row.path)}
            className={ARTIFACT_OPEN_BUTTON_CLASS}
          >
            {t("artifacts.openTask")}
          </button>
        )}
      </div>
      {row.taskTitle !== null && row.taskId !== null && (
        <p className="flex-none truncate ui-meta text-text-faint" title={row.taskId}>
          {t("views.overviewView.artifactsTaskOf", { title: row.taskTitle })}
          <span className="font-mono"> · {row.taskId}</span>
        </p>
      )}
      {openError !== null && (
        <p role="alert" className="flex-none font-mono ui-micro text-status-blocked">
          {openError}
        </p>
      )}
      <div className="min-h-0 flex-1">
        {row.taskId === null ? (
          <p className="ui-meta text-text-faint">{t("artifacts.preview.noTask")}</p>
        ) : document.isPending ? (
          <p className="ui-meta text-text-faint">{t("artifacts.preview.pending")}</p>
        ) : document.isError ? (
          <p className="ui-meta text-text-faint">{t("artifacts.preview.failed", { error: document.error.message })}</p>
        ) : document.data.blobSha256 === null && document.data.worktreeBody === null ? (
          <p className="ui-meta text-text-faint">{t("artifacts.preview.absent")}</p>
        ) : (
          <HtmlArtifactPreview
            fillAvailable
            content={
              document.data.uncommitted && document.data.worktreeBody !== null
                ? document.data.worktreeBody
                : document.data.body
            }
            path={row.path}
          />
        )}
      </div>
    </div>
  );
}
