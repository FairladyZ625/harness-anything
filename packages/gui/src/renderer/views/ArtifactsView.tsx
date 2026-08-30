import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, FileHtml, FileText } from "@phosphor-icons/react";
import type {
  ArtifactGuiKind,
  ArtifactGuiRowDto,
  ArtifactsListResult,
} from "../../../../daemon/src/protocol/artifacts-gui-contract.ts";
import { DocReader } from "../components/DocReader.tsx";
import { HtmlArtifactPreview } from "../components/HtmlArtifactPreview.tsx";
import { Badge, Chip, Empty, Hint } from "../components/runtime/parts.tsx";
import { EntityRefLink, entityRefOf } from "../components/EntityRefLink.tsx";
import { t, type MessageKey } from "../i18n/index.tsx";
import { formatTime } from "../model/time.ts";
import { useTaskDocumentQuery } from "../task-data.ts";
import { artifactsClient } from "../artifacts-client.ts";
import { isHtmlDocument } from "../components/taskDetail/TaskFilesTab.tsx";

// Artifacts 时间线:一次 `repo.artifacts.list` 读出跨 task 包的 artifacts html/md
// 投影(归属、时间、时间来源都是 daemon 事实),本页只排序呈现与切换 facet;
// 选中行在右栏就地渲染——HTML 走隔离 webview 的 HtmlArtifactPreview(脚本/外联
// 禁用,唯一 HTML 渲染路径),md 走既有 DocReader,不引入第二套渲染。
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
const TIMELINE_PANE_CLASS = [
  "min-h-0 flex-1 overflow-y-auto border-b border-border px-4 pt-3.5 pb-6",
  "@min-[1100px]:border-r @min-[1100px]:border-b-0",
].join(" ");
const PREVIEW_PANE_CLASS = [
  "flex min-h-0 w-full flex-col overflow-hidden border-t border-border bg-surface",
  "@min-[1100px]:w-[46%] @min-[1100px]:border-t-0",
].join(" ");
const PREVIEW_EMPTY_CLASS = [
  "flex min-h-56 flex-1 items-center justify-center px-6 text-center",
  "font-mono text-[11px] text-text-faint",
].join(" ");
const OPEN_TASK_BUTTON_CLASS = [
  "inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5",
  "text-[10.5px] text-text-muted hover:border-border-strong hover:text-text",
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
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden @min-[1100px]:flex-row">
      <div className={TIMELINE_PANE_CLASS}>
        <div className="mb-3 flex flex-wrap items-center gap-1.5" data-testid="artifacts-filters">
          <Chip>{t("artifacts.list.count", { count: String(rows.length) })}</Chip>
          <KindToggle value={kind} kind="html" count={data?.counts.html} onChange={onKindChange} />
          <KindToggle value={kind} kind="md" count={data?.counts.md} onChange={onKindChange} />
        </div>
        {pending ? (
          <Empty>{t("artifacts.loading")}</Empty>
        ) : rows.length === 0 ? (
          <Empty>{t("artifacts.empty")}</Empty>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border" data-testid="artifacts-timeline">
            <table className="w-full border-collapse text-left text-[11.5px]">
              <thead>
                <tr className="bg-surface text-text-muted">
                  {[
                    t("artifacts.list.col.file"),
                    t("artifacts.list.col.task"),
                    t("artifacts.list.col.path"),
                    t("artifacts.list.col.time"),
                  ].map((label) => (
                    <th
                      key={label}
                      className="border-b border-border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.06em]"
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const active = current !== null && sameArtifact(row, current);
                  return (
                    <tr
                      key={`${row.taskId ?? "taskless"}/${row.path}`}
                      data-testid={`artifact-row-${row.taskId ?? "taskless"}-${row.path}`}
                      className={`border-b border-border last:border-b-0 ${active ? "bg-surface" : "hover:bg-surface"}`}
                    >
                      <td className="px-2.5 py-1.5">
                        <button
                          type="button"
                          data-testid={`artifact-focus-${row.taskId ?? "taskless"}-${row.path}`}
                          onClick={() => setSelected(row)}
                          title={t("artifacts.list.open")}
                          className="flex items-center gap-1.5 text-left text-[12px] font-medium hover:text-accent"
                        >
                          {row.kind === "html" ? (
                            <FileHtml weight="duotone" className="size-3.5 shrink-0 text-text-faint" />
                          ) : (
                            <FileText weight="duotone" className="size-3.5 shrink-0 text-text-faint" />
                          )}
                          <span className="min-w-0 truncate">{fileNameOf(row.path)}</span>
                        </button>
                      </td>
                      <td className="px-2.5 py-1.5">
                        {row.taskId === null ? (
                          <Hint>{t("artifacts.taskUnknown")}</Hint>
                        ) : (
                          <TaskLinkCell taskId={row.taskId} title={row.taskTitle} onNavigateTask={onNavigateTask} />
                        )}
                      </td>
                      <td className="max-w-[22rem] px-2.5 py-1.5">
                        <ArtifactPathLink row={row} onNavigateTask={onNavigateTask} />
                      </td>
                      <td className="whitespace-nowrap px-2.5 py-1.5">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="font-mono text-[10.5px] text-text-faint">{displayTime(row.time)}</span>
                          <Badge tip={t(TIME_SOURCE_LABEL[row.timeSource])}>
                            {t(TIME_SOURCE_LABEL[row.timeSource])}
                          </Badge>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <ArtifactPreviewPane repoId={repoId} row={current} onNavigateTask={onNavigateTask} />
    </div>
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

function ArtifactPathLink({
  row,
  onNavigateTask,
}: {
  readonly row: ArtifactGuiRowDto;
  readonly onNavigateTask: (taskId: string) => void;
}) {
  const path = repoPathOf(row);
  if (row.taskId === null) {
    return (
      <span className="block truncate font-mono text-[10px] text-text-faint" title={path}>
        {path}
      </span>
    );
  }
  const taskId = row.taskId;
  return (
    <EntityRefLink
      entityRef={entityRefOf("task", taskId)}
      onNavigate={() => onNavigateTask(taskId)}
      title={t("artifacts.openTask")}
      className="block max-w-full truncate text-left font-mono text-[10px] text-text-faint hover:text-accent"
    >
      {path}
    </EntityRefLink>
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
      className="flex max-w-[16rem] items-center gap-1 truncate text-left hover:text-accent"
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
  return (
    <aside data-testid="artifact-preview-pane" className={PREVIEW_PANE_CLASS}>
      {row === null ? (
        <div className={PREVIEW_EMPTY_CLASS}>{t("artifacts.preview.none")}</div>
      ) : (
        <ArtifactPreviewBody row={row} onNavigateTask={onNavigateTask} document={document} />
      )}
    </aside>
  );
}

function ArtifactPreviewBody({
  row,
  onNavigateTask,
  document,
}: {
  readonly row: ArtifactGuiRowDto;
  readonly onNavigateTask: (taskId: string) => void;
  readonly document: ReturnType<typeof useTaskDocumentQuery>;
}) {
  const taskId = row.taskId;
  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-raised px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-muted" title={repoPathOf(row)}>
          {repoPathOf(row)}
        </span>
        {taskId !== null && (
          <button
            type="button"
            data-testid="artifact-open-task"
            onClick={() => onNavigateTask(taskId)}
            className={OPEN_TASK_BUTTON_CLASS}
          >
            <ArrowRight className="size-3" />
            {t("artifacts.openTask")}
          </button>
        )}
      </header>
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

const sameArtifact = (left: ArtifactGuiRowDto, right: ArtifactGuiRowDto): boolean =>
  left.taskId === right.taskId && left.path === right.path;

const fileNameOf = (rowPath: string): string => rowPath.split("/").at(-1) ?? rowPath;

const repoPathOf = (row: ArtifactGuiRowDto): string =>
  row.packagePath === null ? `tasks/<unmapped>/${row.path}` : `${row.packagePath}/${row.path}`;

const displayTime = (iso: string): string => formatTime(iso, { style: "date-time" }) ?? iso;
