import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowSquareOut, X } from "@phosphor-icons/react";
import type { ArtifactGuiRowDto } from "@harness-anything/daemon/protocol";
import { DenseRow, RowTime } from "../components/primitives/DenseRow";
import { Empty } from "../components/primitives/Empty";
import { Notice } from "../components/primitives/Notice";
import { StatusTag } from "../components/primitives/StatusTag";
import { HtmlArtifactPreview } from "../components/HtmlArtifactPreview.tsx";
import { t } from "../i18n/index.tsx";
import { openArtifactExternally } from "../artifact-open-client.ts";
import { useRepoRow } from "../system-data.ts";
import { useTaskDocumentQuery } from "../task-data.ts";
import { ARTIFACT_OPEN_BUTTON_CLASS, fileNameOf, repoPathOf } from "./ArtifactsView.tsx";

/* ------------------------------------------------------------------ 左列:最新产物速览架 */

/** 速览架默认铺出的最新产物条数:速览不是时间线,完整名单走产物二级页。 */
export const ARTIFACTS_SHELF_LIMIT = 6;

/** 产物行的稳定键(速览架/二级页/键盘导航同一份)。 */
export function artifactRowKey(row: ArtifactGuiRowDto): string {
  return `${row.taskId ?? "taskless"}/${row.path}`;
}

/**
 * 最新 HTML 产物速览架(task_8a83698;2026-10-07 三块区域返工;2026-10-11 意见 1 行点击
 * 改为进产物二级页):一条 `repo.artifacts.list`(kind=html,与产物页同一缓存)取最新
 * 产物,平铺产物名、所属任务与创建时间;行右侧「在浏览器打开」走 openArtifactExternally
 * 的 preload 通道(主进程校验)。无归属任务、纯展示仓的禁用规则与产物页预览头同一份。
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
  /** 行点击的落点:进产物二级页并选中该行(键用 artifactRowKey,与页内列表同源)。 */
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

/* ------------------------------------------------------------------ 产物二级页面(2026-10-11 意见 1) */

/**
 * 产物二级页面:接近全屏的整页浮层——左侧窄列表(全部产物,最新在上),右侧大预览,
 * 默认直接选中展示最新一个产物(或调用方点开的那条),点列表项切换预览。预览本体是
 * ArtifactFocusDetail(HtmlArtifactPreview,脚本/外联禁用,与产物页同一渲染路径);
 * 「跳到所属 task」保留 task_15b1bb96 的落点,「在浏览器打开」与速览架同一 preload
 * 通道。Esc 收起;↑↓ 在列表内移动选中(与 FocusLayer 同一键盘契约)。
 */
export function OverviewArtifactsPage({
  open,
  rows,
  total,
  selectedId,
  onSelect,
  onClose,
  repoId,
  onOpenTask,
}: {
  readonly open: boolean;
  /** daemon 已按时间倒序给出的全部 HTML 产物行(首行即最新)。 */
  readonly rows: readonly ArtifactGuiRowDto[];
  /** 产物总数(计数入标题小字,不占大号数字位)。 */
  readonly total: number;
  readonly selectedId: string | null;
  readonly onSelect: (key: string) => void;
  readonly onClose: () => void;
  readonly repoId: string;
  /** 「跳到所属 task」的落点:进任务页并直接选中该产物文档(包内相对路径)。 */
  readonly onOpenTask: (taskId: string, docPath: string) => void;
}) {
  const keys = rows.map(artifactRowKey);
  const [listWidth, setListWidth] = useState(260);
  const dragRef = useRef<{ readonly startX: number; readonly startWidth: number } | null>(null);

  const onResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragRef.current = { startX: event.clientX, startWidth: listWidth };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [listWidth],
  );

  const onResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null) return;
    const next = Math.min(480, Math.max(180, Math.round(drag.startWidth + (event.clientX - drag.startX))));
    setListWidth(next);
  }, []);

  const onResizePointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const onResetWidth = useCallback(() => {
    setListWidth(260);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if (keys.length === 0) return;
      const current = keys.indexOf(selectedId ?? ""),
        next =
          event.key === "ArrowDown"
            ? Math.min(keys.length - 1, current + 1)
            : Math.max(0, current === -1 ? 0 : current - 1);
      event.preventDefault();
      if (keys[next] !== undefined && keys[next] !== selectedId) onSelect(keys[next]);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, keys, selectedId, onClose, onSelect]);
  if (!open) return null;
  const selected = rows.find((row) => artifactRowKey(row) === selectedId) ?? null;
  return createPortal(
    <>
      <div
        data-testid="overview-artifacts-page-scrim"
        className="fixed inset-0 z-11 bg-black/40 backdrop-blur-xs"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        data-testid="overview-artifacts-page"
        role="dialog"
        aria-modal="true"
        aria-label={t("views.overviewView.artifactsPageTitle")}
        className="glass glass-overlay fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-11 flex h-[85vh] w-[88vw] min-h-[500px] min-w-[640px] max-h-[90vh] max-w-[94vw] flex-col overflow-hidden rounded-lg border border-border shadow-2xl"
      >
        <header className="flex flex-none items-center gap-2.5 px-[18px] pb-[10px] pt-[14px]">
          <h2 className="min-w-0 truncate font-semibold ui-title">{t("views.overviewView.artifactsPageTitle")}</h2>
          <span className="shrink-0 font-mono tabular-nums text-text-faint ui-meta">
            {t("views.overviewView.artifactsPageCount", { count: String(total) })}
          </span>
          <button
            type="button"
            onClick={onClose}
            data-testid="overview-artifacts-page-close"
            aria-label={t("components.primitives.close")}
            className="ml-auto grid size-[26px] shrink-0 place-items-center rounded-xs border border-border bg-text/10 text-text-muted hover:text-text"
          >
            <X weight="bold" className="ui-meta" />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-row overflow-hidden border-t border-border">
          {/* 左列表窄列:全部产物行,区内滚动;行点击/键盘 ↑↓ 换预览。 */}
          <div
            data-testid="overview-artifacts-page-list"
            style={{ width: listWidth }}
            className="min-h-0 shrink-0 overflow-y-auto"
          >
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
          </div>
          {/* 分隔条:支持拖拽改变左栏宽度,双击重置为默认 260px */}
          <div
            role="separator"
            aria-orientation="vertical"
            data-testid="overview-artifacts-page-resize"
            title={t("artifacts.drawer.resizeTitle")}
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            onPointerCancel={onResizePointerUp}
            onDoubleClick={onResetWidth}
            className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-accent"
          />
          {/* 右预览占大头:业主「我点进来是为了看页面,不是为看列表」。 */}
          <div className="min-h-0 flex-1 overflow-y-auto px-[18px] py-[14px]">
            {selected === null ? (
              <p className="ui-meta text-text-faint">{t("views.overviewView.artifactsShelfEmpty")}</p>
            ) : (
              <ArtifactFocusDetail repoId={repoId} row={selected} onOpenTask={onOpenTask} />
            )}
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}

/** 产物预览右栏:直接渲染该 HTML 的隔离预览(HtmlArtifactPreview,脚本/外联禁用,与
 * 产物页同一渲染路径),「跳到所属 task」保留 task_15b1bb96 的落点(进任务页并直接
 * 选中该产物文档),「在浏览器打开」与速览架行按钮同一 preload 通道。 */
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
