import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  ArrowSquareOut,
  ArrowsInLineHorizontal,
  ArrowsOutLineHorizontal,
  FileHtml,
  FileText,
} from "@phosphor-icons/react";
import type {
  ArtifactGuiKind,
  ArtifactGuiRowDto,
  ArtifactsListResult,
} from "../../../../daemon/src/protocol/artifacts-gui-contract.ts";
import { DocReader } from "../components/DocReader.tsx";
import { HtmlArtifactPreview } from "../components/HtmlArtifactPreview.tsx";
import { Badge, Chip, Empty, Hint } from "../components/runtime/parts.tsx";
import { t, type MessageKey } from "../i18n/index.tsx";
import { formatTime } from "../model/time.ts";
import { useTaskDocumentQuery } from "../task-data.ts";
import { artifactsClient } from "../artifacts-client.ts";
import { consumeKnownError } from "../../api/error-consumption.ts";
import { isHtmlDocument } from "../components/taskDetail/TaskFilesTab.tsx";
import { openArtifactExternally } from "../artifact-open-client.ts";

// Artifacts 抽屉(task_7e713fee 重排):一次 `repo.artifacts.list` 读出跨 task 包的
// artifacts html/md 投影(归属、时间、时间来源都是 daemon 事实),本页只排序呈现与切换
// facet;左抽屉按时间倒序列产物,右侧整块高度预览 —— HTML 走隔离 webview 的
// HtmlArtifactPreview(脚本/外联禁用,唯一 HTML 渲染路径),md 走既有 DocReader,
// 不引入第二套渲染。「在默认浏览器打开」走 preload 的 artifacts.openExternal
// (主进程校验后才 shell.openPath,见 main/artifact-open-ipc.ts)。
const KIND_LABEL: Record<ArtifactGuiKind, MessageKey> = {
  html: "artifacts.kind.html",
  md: "artifacts.kind.md",
};
const TIME_SOURCE_LABEL: Record<ArtifactGuiRowDto["timeSource"], MessageKey> = {
  ledger: "artifacts.timeSource.ledger",
  mtime: "artifacts.timeSource.mtime",
};

const READ_ERROR_ROW_CLASS = [
  "shrink-0 border-b border-border bg-status-blocked/10",
  "px-3.5 py-1.5 font-mono text-[11px] text-status-blocked",
].join(" ");
const DRAWER_MIN_PX = 200;
const OPEN_BUTTON_CLASS = [
  "inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5",
  "text-[10.5px] text-text-muted hover:border-border-strong hover:text-text",
].join(" ");
const ROW_CLASS = [
  "w-full rounded-md border border-border bg-surface-raised px-2 py-1.5 text-left",
  "transition-colors duration-100 hover:border-accent/60",
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
    queryKey: ["artifacts", repoId, kind],
    queryFn: () => artifactsClient.list(repoId, kind),
    staleTime: 10_000,
  });
  return (
    <section data-testid="artifacts-view" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-[42px] shrink-0 items-center gap-3 border-b border-border bg-surface-raised px-3.5">
        <b className="text-[13px] tracking-[0.02em]">{t("artifacts.title")}</b>
        <span className="truncate font-mono text-[10.5px] text-text-faint">{t("artifacts.subtitle")}</span>
        {query.data && (
          <span className="ml-auto whitespace-nowrap font-mono text-[10.5px] text-text-faint">
            {t("artifacts.counts", { html: String(query.data.counts.html), md: String(query.data.counts.md) })}
          </span>
        )}
      </header>
      {query.isError && (
        <p role="alert" data-testid="artifacts-read-error" className={READ_ERROR_ROW_CLASS}>
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
  const current = useMemo(
    () => (selected === null ? null : (rows.find((row) => sameArtifact(row, selected)) ?? null)),
    [rows, selected],
  );
  const [drawer, setDrawer] = useState<ArtifactDrawerState>(() => readArtifactDrawerState());
  const rowHostRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ readonly startX: number; readonly startWidth: number } | null>(null);

  useEffect(() => {
    writeArtifactDrawerState(drawer);
  }, [drawer]);

  // 拖右边缘改宽:左抽屉向左拖变宽。宽度钳在 [200px, 容器宽 50%]。
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
    const next = clampDrawerWidth(drag.startWidth + (drag.startX - event.clientX), max);
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
          <span className="font-mono text-[10px] [writing-mode:vertical-rl]">{t("artifacts.drawer.collapsed")}</span>
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
              <Chip>{t("artifacts.list.count", { count: String(rows.length) })}</Chip>
              <KindToggle value={kind} kind="html" count={data?.counts.html} onChange={onKindChange} />
              <KindToggle value={kind} kind="md" count={data?.counts.md} onChange={onKindChange} />
              <button
                type="button"
                data-testid="artifacts-drawer-collapse"
                onClick={() => setDrawer((state) => ({ ...state, collapsed: true }))}
                title={t("artifacts.drawer.collapseTitle")}
                aria-label={t("artifacts.drawer.collapseTitle")}
                className="ml-auto rounded p-1 text-text-faint hover:bg-surface-raised hover:text-text"
              >
                <ArrowsOutLineHorizontal weight="bold" className="size-3.5 rotate-90" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2" data-testid="artifacts-timeline">
              {pending ? (
                <Empty>{t("artifacts.loading")}</Empty>
              ) : rows.length === 0 ? (
                <Empty>{t("artifacts.empty")}</Empty>
              ) : (
                <ul className="flex flex-col gap-1">
                  {rows.map((row) => (
                    <ArtifactRow
                      key={`${row.taskId ?? "taskless"}/${row.path}`}
                      row={row}
                      active={current !== null && sameArtifact(row, current)}
                      onSelect={() => setSelected(row)}
                      onNavigateTask={onNavigateTask}
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
      <ArtifactPreviewPane repoId={repoId} row={current} onNavigateTask={onNavigateTask} />
    </div>
  );
}

function ArtifactRow({
  row,
  active,
  onSelect,
  onNavigateTask,
}: {
  readonly row: ArtifactGuiRowDto;
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly onNavigateTask: (taskId: string) => void;
}) {
  return (
    <li>
      <div
        data-testid={`artifact-row-${row.taskId ?? "taskless"}-${row.path}`}
        className={`${ROW_CLASS} ${active ? "border-accent/60 bg-surface" : ""}`}
        title={repoPathOf(row)}
      >
        <button
          type="button"
          data-testid={`artifact-focus-${row.taskId ?? "taskless"}-${row.path}`}
          onClick={onSelect}
          title={t("artifacts.list.open")}
          className="flex w-full items-center gap-1.5 text-left text-[12px] font-medium hover:text-accent"
        >
          {row.kind === "html" ? (
            <FileHtml weight="duotone" className="size-3.5 shrink-0 text-text-faint" />
          ) : (
            <FileText weight="duotone" className="size-3.5 shrink-0 text-text-faint" />
          )}
          <span className="min-w-0 flex-1 truncate">{fileNameOf(row.path)}</span>
          {/* 相对时间是主显;绝对时间与时间来源(台账 occurredAt 还是文件 mtime)进 tooltip,
              mtime 这个「非台账事实」额外显形在正文里,不给它和 ledger 同等的安静。 */}
          <span
            className="shrink-0 font-mono text-[10px] text-text-faint"
            title={`${displayTime(row.time)} · ${t(TIME_SOURCE_LABEL[row.timeSource])}`}
          >
            {relativeTimeOf(row.time)}
            {row.timeSource === "mtime" ? ` · ${t("artifacts.timeSource.mtime")}` : ""}
          </span>
          <Badge tip={t(TIME_SOURCE_LABEL[row.timeSource])}>{t(KIND_LABEL[row.kind])}</Badge>
        </button>
        {row.taskId === null ? (
          <Hint>{t("artifacts.taskUnknown")}</Hint>
        ) : (
          <TaskLinkCell taskId={row.taskId} title={row.taskTitle} onNavigateTask={onNavigateTask} />
        )}
      </div>
    </li>
  );
}

function KindToggle({
  value,
  kind,
  count,
  onChange,
}: {
  readonly value: ArtifactGuiKind;
  readonly kind: ArtifactGuiKind;
  readonly count: number | undefined;
  readonly onChange: (kind: ArtifactGuiKind) => void;
}) {
  return (
    <button
      type="button"
      data-testid={`artifacts-filter-${kind}`}
      aria-pressed={value === kind}
      onClick={() => onChange(kind)}
      className={
        value === kind
          ? "rounded border border-border-strong bg-accent px-2 py-0.5 text-[10.5px] font-semibold text-accent-fg"
          : "rounded border border-border px-2 py-0.5 text-[10.5px] text-text-muted hover:bg-surface"
      }
    >
      {t(KIND_LABEL[kind])}
      {count === undefined ? "" : ` · ${count}`}
    </button>
  );
}

function TaskLinkCell({
  taskId,
  title,
  onNavigateTask,
}: {
  readonly taskId: string;
  readonly title: string | null;
  readonly onNavigateTask: (taskId: string) => void;
}) {
  return (
    <button
      type="button"
      data-testid={`artifact-task-${taskId}`}
      onClick={() => onNavigateTask(taskId)}
      title={t("artifacts.openTask")}
      className="flex max-w-full items-center gap-1 truncate text-left text-[11px] text-text-muted hover:text-accent"
    >
      <span className="min-w-0 truncate">{title ?? taskId}</span>
      <ArrowRight className="size-3 shrink-0 text-text-faint" />
    </button>
  );
}

function ArtifactPreviewPane({
  repoId,
  row,
  onNavigateTask,
}: {
  readonly repoId: string;
  readonly row: ArtifactGuiRowDto | null;
  readonly onNavigateTask: (taskId: string) => void;
}) {
  const document = useTaskDocumentQuery(repoId, row?.taskId ?? "", row?.path ?? null);
  const [openError, setOpenError] = useState<string | null>(null);
  const openExternally = useCallback(async () => {
    if (row === null) return;
    setOpenError(null);
    const outcome = await openArtifactExternally({ repoId, path: repoPathOf(row) });
    if (outcome.error !== null) setOpenError(outcome.error);
  }, [repoId, row]);
  return (
    <aside
      data-testid="artifact-preview-pane"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface"
    >
      {row === null ? (
        <div
          className={[
            "flex min-h-56 flex-1 items-center justify-center px-6 text-center",
            "font-mono text-[11px] text-text-faint",
          ].join(" ")}
        >
          {t("artifacts.preview.none")}
        </div>
      ) : (
        <ArtifactPreviewBody
          row={row}
          onNavigateTask={onNavigateTask}
          document={document}
          onOpenExternally={openExternally}
          openError={openError}
        />
      )}
    </aside>
  );
}

function ArtifactPreviewBody({
  row,
  onNavigateTask,
  document,
  onOpenExternally,
  openError,
}: {
  readonly row: ArtifactGuiRowDto;
  readonly onNavigateTask: (taskId: string) => void;
  readonly document: ReturnType<typeof useTaskDocumentQuery>;
  readonly onOpenExternally: () => void;
  readonly openError: string | null;
}) {
  const taskId = row.taskId;
  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-raised px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-muted" title={repoPathOf(row)}>
          {repoPathOf(row)}
        </span>
        <button
          type="button"
          data-testid="artifact-open-external"
          onClick={onOpenExternally}
          disabled={row.packagePath === null}
          title={
            row.packagePath === null
              ? t("artifacts.preview.openExternalNoPackage")
              : t("artifacts.preview.openExternalTitle")
          }
          className={OPEN_BUTTON_CLASS}
        >
          <ArrowSquareOut className="size-3" />
          {t("artifacts.preview.openExternal")}
        </button>
        {taskId !== null && (
          <button
            type="button"
            data-testid="artifact-open-task"
            onClick={() => onNavigateTask(taskId)}
            className={OPEN_BUTTON_CLASS}
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
          className="px-3 py-1.5 font-mono text-[11px] text-status-blocked"
        >
          {openError}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {row.taskId === null ? (
          <PreviewNote text={t("artifacts.preview.noTask")} />
        ) : document.isPending ? (
          <PreviewNote text={t("artifacts.preview.pending")} />
        ) : document.isError ? (
          <PreviewNote text={t("artifacts.preview.failed", { error: document.error.message })} />
        ) : document.data.blobSha256 === null && document.data.worktreeBody === null ? (
          <PreviewNote text={t("artifacts.preview.absent")} />
        ) : // 工作树实时内容优先(与 Task 详情文件页同一规则):未提交的产物是真实工作。
        isHtmlDocument(row.path) ? (
          <HtmlArtifactPreview
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
  return <p className="px-1 py-3 text-[12px] text-text-faint">{text}</p>;
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

// ---- 纯函数 ----

const sameArtifact = (left: ArtifactGuiRowDto, right: ArtifactGuiRowDto): boolean =>
  left.taskId === right.taskId && left.path === right.path;

const fileNameOf = (rowPath: string): string => rowPath.split("/").at(-1) ?? rowPath;

const repoPathOf = (row: ArtifactGuiRowDto): string =>
  row.packagePath === null ? `tasks/<unmapped>/${row.path}` : `${row.packagePath}/${row.path}`;

const displayTime = (iso: string): string => formatTime(iso, { style: "date-time" }) ?? iso;

/** 相对时间:两分钟内“刚刚”，之后按分/时/天取整，超过 30 天回落到日期。 */
function relativeTimeOf(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return displayTime(iso);
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1_000));
  if (seconds < 120) return t("artifacts.list.justNow");
  if (seconds < 7_200) return t("artifacts.list.minutesAgo", { minutes: String(Math.round(seconds / 60)) });
  if (seconds < 172_800) return t("artifacts.list.hoursAgo", { hours: String(Math.round(seconds / 3_600)) });
  if (seconds < 2_592_000) return t("artifacts.list.daysAgo", { days: String(Math.round(seconds / 86_400)) });
  return displayTime(iso);
}
