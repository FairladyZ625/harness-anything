import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowSquareOut, ArrowsInLineHorizontal, ArrowsOutLineHorizontal } from "@phosphor-icons/react";
import type { ArtifactGuiKind, ArtifactGuiRowDto, ArtifactsListResult } from "@harness-anything/daemon/protocol";
import { BinaryArtifactPanel } from "../components/BinaryArtifactPanel.tsx";
import { DocReader } from "../components/DocReader.tsx";
import { HtmlArtifactPreview } from "../components/HtmlArtifactPreview.tsx";
import { DenseRow } from "../components/primitives/DenseRow.tsx";
import { FilterChips } from "../components/primitives/FilterChips.tsx";
import { PageHeader } from "../components/primitives/PageHeader.tsx";
import { StatusTag } from "../components/primitives/StatusTag.tsx";
import { Empty } from "../components/primitives/Empty.tsx";
import { t, type MessageKey } from "../i18n/index.tsx";
import { formatListTime, formatTime } from "../model/time.ts";
import { useTaskDocumentQuery } from "../task-data.ts";
import { useRepoRow } from "../system-data.ts";
import { artifactsClient, artifactsQueryKeys } from "../artifacts-client.ts";
import { consumeKnownError } from "../../api/error-consumption.ts";
import { isHtmlDocument } from "../entity-locator-renderer.ts";
import { openArtifactExternally } from "../artifact-open-client.ts";

// Artifacts 抽屉(task_7e713fee 重排,视觉基线 v1 §2.4 行与筛选):一次 `repo.artifacts.list`
// 读出跨 task 包的 artifacts html/md 投影(归属、时间、时间来源都是 daemon 事实),本页只
// 排序呈现与切换 facet;左抽屉按时间倒序列产物(DenseRow,kind 为有底色标签),右侧整块高度
// 预览 —— HTML 走隔离 webview 的 HtmlArtifactPreview(脚本/外联禁用,唯一 HTML 渲染路径),
// md 走既有 DocReader,不引入第二套渲染。「在默认浏览器打开」走 preload 的
// artifacts.openExternal(主进程校验后才 shell.openPath,见 main/artifact-open-ipc.ts)。
const KIND_LABEL: Record<ArtifactGuiKind, MessageKey> = {
  html: "artifacts.kind.html",
  md: "artifacts.kind.md",
  raw: "artifacts.kind.raw",
};
const TIME_SOURCE_LABEL: Record<ArtifactGuiRowDto["timeSource"], MessageKey> = {
  ledger: "artifacts.timeSource.ledger",
  mtime: "artifacts.timeSource.mtime",
};

/** 读失败行(页面与工作台产物面板共用):等宽微字 + 红底细行。 */
export const ARTIFACTS_READ_ERROR_ROW_CLASS = [
  "shrink-0 border-b border-border bg-status-blocked/10",
  "px-3.5 py-1.5 font-mono ui-micro text-status-blocked",
].join(" ");
const DRAWER_MIN_PX = 200;
/** 行内小动作按钮的共享档(产物页预览头与总览速览架行同一档)。 */
export const ARTIFACT_OPEN_BUTTON_CLASS = [
  "inline-flex shrink-0 items-center gap-1 rounded-xs border border-border px-1.5 py-0.5",
  "ui-micro text-text-muted hover:border-border-strong hover:text-text",
  "disabled:pointer-events-none disabled:opacity-40",
].join(" ");

export function ArtifactsView({
  repoId,
  onNavigateTask,
}: {
  readonly repoId: string;
  readonly onNavigateTask: (taskId: string) => void;
}) {
  const [kind, setKind] = useState<ArtifactGuiKind>("html");
  const query = useQuery({
    queryKey: artifactsQueryKeys.list(repoId, kind),
    queryFn: () => artifactsClient.list(repoId, kind),
    staleTime: 10_000,
  });
  return (
    <section data-testid="artifacts-view" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <PageHeader
        title={t("artifacts.title")}
        note={t("artifacts.subtitle")}
        meta={
          query.data ? (
            <span data-testid="artifacts-counts" className="whitespace-nowrap">
              {t("artifacts.counts", {
                html: String(query.data.counts.html),
                md: String(query.data.counts.md),
                raw: String(query.data.counts.raw),
              })}
            </span>
          ) : undefined
        }
      />
      {query.isError && (
        <p role="alert" data-testid="artifacts-read-error" className={ARTIFACTS_READ_ERROR_ROW_CLASS}>
          {t("artifacts.readFailed", {
            error: query.error instanceof Error ? query.error.message : String(query.error),
          })}
        </p>
      )}
      <ArtifactsWorkspace
        repoId={repoId}
        data={query.data ?? null}
        pending={query.isPending}
        kind={kind}
        onKindChange={setKind}
        onNavigateTask={onNavigateTask}
      />
    </section>
  );
}

export function ArtifactsWorkspace({
  repoId,
  data,
  pending,
  kind,
  onKindChange,
  onNavigateTask,
}: {
  readonly repoId: string;
  readonly data: ArtifactsListResult | null;
  readonly pending: boolean;
  readonly kind: ArtifactGuiKind;
  readonly onKindChange: (kind: ArtifactGuiKind) => void;
  readonly onNavigateTask: (taskId: string) => void;
}) {
  const rows = data?.artifacts ?? [];
  const [selected, setSelected] = useState<ArtifactGuiRowDto | null>(null);
  const current = useMemo(() => {
    if (rows.length === 0) return null;
    if (selected === null) return rows[0]!;
    return rows.find((row) => sameArtifact(row, selected)) ?? rows[0]!;
  }, [rows, selected]);
  const [drawer, setDrawer] = useState<ArtifactDrawerState>(() => readArtifactDrawerState());
  const rowHostRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ readonly startX: number; readonly startWidth: number } | null>(null);

  useEffect(() => {
    writeArtifactDrawerState(drawer);
  }, [drawer]);

  // 拖右边缘改宽:水平位移直接加到左抽屉宽度,宽度钳在 [200px, 容器宽 50%]。
  const onResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragRef.current = { startX: event.clientX, startWidth: drawer.width };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [drawer.width],
  );
  const onResizePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null) return;
    const host = rowHostRef.current;
    const max = host === null ? Number.POSITIVE_INFINITY : Math.floor(host.clientWidth / 2);
    const next = clampDrawerWidth(drag.startWidth + (event.clientX - drag.startX), max);
    setDrawer((state) => (state.width === next ? state : { ...state, width: next }));
  }, []);
  const onResizePointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  return (
    <div ref={rowHostRef} className="flex min-h-0 flex-1 flex-row overflow-hidden" data-testid="artifacts-drawer-row">
      {drawer.collapsed ? (
        <button
          type="button"
          data-testid="artifacts-drawer-expand"
          onClick={() => setDrawer((state) => ({ ...state, collapsed: false }))}
          title={t("artifacts.drawer.expandTitle")}
          aria-label={t("artifacts.drawer.expandTitle")}
          className={[
            "flex w-8 shrink-0 flex-col items-center gap-2 border-r border-border",
            "bg-surface py-3 text-text-faint hover:text-text",
          ].join(" ")}
        >
          <ArrowsInLineHorizontal weight="bold" className="size-4 shrink-0 rotate-90" />
          <span className="font-mono ui-micro [writing-mode:vertical-rl]">{t("artifacts.drawer.collapsed")}</span>
        </button>
      ) : (
        <>
          <aside
            data-testid="artifacts-drawer"
            className="flex min-h-0 shrink-0 flex-col border-r border-border bg-surface"
            style={{ width: `${drawer.width}px` }}
          >
            <div
              className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2"
              data-testid="artifacts-filters"
            >
              <FilterChips
                value={kind}
                onChange={onKindChange}
                chips={(["html", "md", "raw"] as const).map((key) => ({
                  key,
                  label: t(KIND_LABEL[key]),
                  count: data?.counts[key] ?? rows.length,
                }))}
              />
              <button
                type="button"
                data-testid="artifacts-drawer-collapse"
                onClick={() => setDrawer((state) => ({ ...state, collapsed: true }))}
                title={t("artifacts.drawer.collapseTitle")}
                aria-label={t("artifacts.drawer.collapseTitle")}
                className="ml-auto rounded-xs p-1 text-text-faint hover:bg-surface-raised hover:text-text"
              >
                <ArrowsOutLineHorizontal weight="bold" className="size-3.5 rotate-90" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto" data-testid="artifacts-timeline">
              {pending ? (
                <Empty>{t("artifacts.loading")}</Empty>
              ) : rows.length === 0 ? (
                <Empty>{t("artifacts.empty")}</Empty>
              ) : (
                <ul className="flex flex-col">
                  {rows.map((row) => (
                    <ArtifactRow
                      key={`${row.taskId ?? "taskless"}/${row.path}`}
                      row={row}
                      active={current !== null && sameArtifact(row, current)}
                      onSelect={() => setSelected(row)}
                    />
                  ))}
                </ul>
              )}
            </div>
          </aside>
          <div
            role="separator"
            aria-orientation="vertical"
            data-testid="artifacts-drawer-resize"
            title={t("artifacts.drawer.resizeTitle")}
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
            onPointerCancel={onResizePointerUp}
            className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-accent"
          />
        </>
      )}
      {current !== null ? <ArtifactPreviewPane repoId={repoId} row={current} onNavigateTask={onNavigateTask} /> : null}
    </div>
  );
}

function ArtifactRow({
  row,
  active,
  onSelect,
}: {
  readonly row: ArtifactGuiRowDto;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <li data-testid={`artifact-row-${row.taskId ?? "taskless"}-${row.path}`} title={repoPathOf(row)}>
      {/* 整卡只有一种点击:打开预览(泽宇 2026-08-31 亲裁,一个组件不承载两种点击)。
          跳所属 task 的唯一出口在预览头按钮;所属 task 标题在行内只作信息展示。
          相对时间是主显;绝对时间与时间来源(台账 occurredAt 还是文件 mtime)进 tooltip,
          mtime 这个「非台账事实」额外显形在正文里,不给它和 ledger 同等的安静。 */}
      <DenseRow
        relaxed
        tag={<StatusTag tone="neutral" label={t(KIND_LABEL[row.kind])} />}
        title={fileNameOf(row.path)}
        reason={
          <span>
            {row.taskId === null ? (
              t("artifacts.taskUnknown")
            ) : (
              <span title={row.taskId}>{row.taskTitle ?? row.taskId}</span>
            )}
            {row.timeSource === "mtime" ? ` · ${t("artifacts.timeSource.mtime")}` : ""}
          </span>
        }
        time={
          <span
            title={`${formatTime(row.time, { style: "date-time-seconds" }) ?? row.time} · ${t(TIME_SOURCE_LABEL[row.timeSource])}`}
          >
            {formatListTime(row.time)}
          </span>
        }
        selected={active}
        onClick={onSelect}
      />
    </li>
  );
}

function ArtifactPreviewPane({
  repoId,
  row,
  onNavigateTask,
}: {
  readonly repoId: string;
  readonly row: ArtifactGuiRowDto;
  readonly onNavigateTask: (taskId: string) => void;
}) {
  const document = useTaskDocumentQuery(repoId, row.taskId ?? "", row.path);
  // 纯展示(remote-proxy)仓的「打开」走主进程物化副本统一面,按钮旁标注服务器副本。
  const remoteProxy = useRepoRow(repoId)?.mode === "remote-proxy";
  const [openError, setOpenError] = useState<string | null>(null);
  const openExternally = useCallback(async () => {
    setOpenError(null);
    const outcome = await openArtifactExternally({
      repoId,
      path: repoPathOf(row),
      ...(row.taskId !== null ? { taskId: row.taskId } : {}),
    });
    if (outcome.error !== null) setOpenError(outcome.error);
  }, [repoId, row]);
  return (
    <aside
      data-testid="artifact-preview-pane"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface"
    >
      <ArtifactPreviewBody
        repoId={repoId}
        row={row}
        onNavigateTask={onNavigateTask}
        document={document}
        onOpenExternally={openExternally}
        openError={openError}
        remoteProxy={remoteProxy}
      />
    </aside>
  );
}

function ArtifactPreviewBody({
  repoId,
  row,
  onNavigateTask,
  document,
  onOpenExternally,
  openError,
  remoteProxy,
}: {
  readonly repoId: string;
  readonly row: ArtifactGuiRowDto;
  readonly onNavigateTask: (taskId: string) => void;
  readonly document: ReturnType<typeof useTaskDocumentQuery>;
  readonly onOpenExternally: () => void;
  readonly openError: string | null;
  readonly remoteProxy: boolean;
}) {
  const taskId = row.taskId;
  const html = isHtmlDocument(row.path);
  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-raised px-3 py-2">
        {taskId !== null ? (
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left font-mono ui-micro text-text-muted hover:text-text"
            title={repoPathOf(row)}
            onClick={() => onNavigateTask(taskId)}
          >
            {repoPathOf(row)}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono ui-micro text-text-muted" title={repoPathOf(row)}>
            {repoPathOf(row)}
          </span>
        )}
        <button
          type="button"
          data-testid="artifact-open-external"
          onClick={onOpenExternally}
          disabled={row.packagePath === null || (remoteProxy && row.taskId === null)}
          title={
            row.packagePath === null
              ? t("artifacts.preview.openExternalNoPackage")
              : remoteProxy
                ? t("artifacts.preview.serverCopyTitle")
                : t("artifacts.preview.openExternalTitle")
          }
          className={ARTIFACT_OPEN_BUTTON_CLASS}
        >
          <ArrowSquareOut className="size-3" />
          {t("artifacts.preview.openExternal")}
        </button>
        {remoteProxy ? (
          <span
            data-testid="artifact-server-copy-note"
            title={t("artifacts.preview.serverCopyTitle")}
            className={
              "inline-flex shrink-0 items-center rounded border " +
              "border-accent/40 px-1 py-px font-mono ui-micro text-accent"
            }
          >
            {t("artifacts.preview.serverCopy")}
          </span>
        ) : null}
        {taskId !== null && (
          <button
            type="button"
            data-testid="artifact-open-task"
            onClick={() => onNavigateTask(taskId)}
            className={ARTIFACT_OPEN_BUTTON_CLASS}
          >
            <ArrowRight className="size-3" />
            {t("artifacts.openTask")}
          </button>
        )}
      </header>
      {openError !== null && (
        <p
          role="alert"
          data-testid="artifact-open-external-error"
          className="px-3 py-1.5 font-mono ui-micro text-status-blocked"
        >
          {openError}
        </p>
      )}
      <div
        data-testid="artifact-preview-content"
        className={`min-h-0 flex-1 p-3 ${html ? "overflow-hidden" : "overflow-y-auto"}`}
      >
        {taskId === null ? (
          <PreviewNote text={t("artifacts.preview.noTask")} />
        ) : document.isPending ? (
          <PreviewNote text={t("artifacts.preview.pending")} />
        ) : document.isError ? (
          <PreviewNote text={t("artifacts.preview.failed", { error: document.error.message })} />
        ) : /* 二进制产物先于「未物化」判定:它的 body 本来就是空的,交给 DocReader 会是一张
             白页,而 blobSha256 为 null 只说明还没入账,不说明这个文件不存在。 */
        document.data.contentKind === "binary" ? (
          <BinaryArtifactPanel
            repoId={repoId}
            taskId={taskId}
            path={row.path}
            packagePath={row.packagePath}
            read={document.data}
          />
        ) : document.data.blobSha256 === null && document.data.worktreeBody === null ? (
          <PreviewNote text={t("artifacts.preview.absent")} />
        ) : // 工作树实时内容优先(与 Task 详情文件页同一规则):未提交的产物是真实工作。
        html ? (
          <HtmlArtifactPreview
            fillAvailable
            content={
              document.data.uncommitted && document.data.worktreeBody !== null
                ? document.data.worktreeBody
                : document.data.body
            }
            path={row.path}
          />
        ) : (
          <DocReader
            content={
              document.data.uncommitted && document.data.worktreeBody !== null
                ? document.data.worktreeBody
                : document.data.body
            }
          />
        )}
      </div>
    </>
  );
}

function PreviewNote({ text }: { readonly text: string }) {
  return <p className="px-1 py-3 ui-meta text-text-faint">{text}</p>;
}

// ---- 抽屉宽度与折叠态的 localStorage 记忆(task_7e713fee)----

const DRAWER_STORAGE_KEY = "harness:gui:artifacts-drawer";
const DRAWER_DEFAULT_WIDTH = 420;

interface ArtifactDrawerState {
  readonly width: number;
  readonly collapsed: boolean;
}

function clampDrawerWidth(width: number, max: number): number {
  const ceiling = Number.isFinite(max) ? Math.max(DRAWER_MIN_PX, max) : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(DRAWER_MIN_PX, Math.round(width)), ceiling);
}

function readArtifactDrawerState(): ArtifactDrawerState {
  const fallback: ArtifactDrawerState = { width: DRAWER_DEFAULT_WIDTH, collapsed: false };
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(DRAWER_STORAGE_KEY) ?? "null");
    if (typeof parsed !== "object" || parsed === null) return fallback;
    const record = parsed as { width?: unknown; collapsed?: unknown };
    return {
      width: typeof record.width === "number" ? clampDrawerWidth(record.width, Number.NaN) : fallback.width,
      collapsed: record.collapsed === true,
    };
  } catch {
    return fallback;
  }
}

function writeArtifactDrawerState(state: ArtifactDrawerState): void {
  try {
    window.localStorage.setItem(DRAWER_STORAGE_KEY, JSON.stringify(state));
  } catch (cause) {
    // 隐私模式/quota 满:本会话抽屉仍生效，只是不跨会话记忆。
    consumeKnownError(cause);
  }
}

// ---- 纯函数(产物页与总览速览架共用:行显示名与 repo 相对路径只在这一份) ----

const sameArtifact = (left: ArtifactGuiRowDto, right: ArtifactGuiRowDto): boolean =>
  left.taskId === right.taskId && left.path === right.path;

export const fileNameOf = (rowPath: string): string => rowPath.split("/").at(-1) ?? rowPath;

export const repoPathOf = (row: ArtifactGuiRowDto): string =>
  row.packagePath === null ? `tasks/<unmapped>/${row.path}` : `${row.packagePath}/${row.path}`;
