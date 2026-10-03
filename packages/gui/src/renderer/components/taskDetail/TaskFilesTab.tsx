import { RegionDragHandle, RegionLayoutControls } from "../primitives/page-regions.tsx";
import { useEffect, useMemo, type ReactNode } from "react";
import { CaretRight, FileText } from "@phosphor-icons/react";
import { EntityRefLink, entityRefOf } from "../EntityRefLink.tsx";
import { DocReader } from "../DocReader.tsx";
import { HtmlArtifactPreview } from "../HtmlArtifactPreview.tsx";
import { buildDocTree, projectedDocuments } from "../../model/docTree.ts";
import type { TaskRow } from "../../model/types.ts";
import { useTaskDocumentListQuery, useTaskDocumentQuery } from "../../task-data.ts";
import { BinaryArtifactPanel } from "../BinaryArtifactPanel.tsx";
import { DocTree } from "./DocTree.tsx";
import { isHtmlDocument } from "../../entity-locator-renderer.ts";

interface TaskDocumentSidebarProps {
  readonly task: TaskRow;
  readonly activeDoc: string;
  readonly onActiveDocChange: (path: string) => void;
  readonly onOpenDoc: (path: string) => void;
  /** 头部右侧的控件位(task_fb3ba20d66…:文件树|正文分割的排列/折叠/重置)。 */
  readonly headerExtra?: ReactNode;
}

export function TaskDocumentSidebar(props: TaskDocumentSidebarProps) {
  const task = props.task;
  const activeDoc = props.activeDoc;
  const onActiveDocChange = props.onActiveDocChange;
  const onOpenDoc = props.onOpenDoc;
  const documentList = useTaskDocumentListQuery(task.projectId, task.taskId);
  const documents = useMemo(
    () =>
      projectedDocuments(
        documentList.data?.status === "ready"
          ? documentList.data.documents.map((document) => ({
              path: document.path,
              ...(document.uncommitted ? { uncommitted: true } : {}),
            }))
          : [],
      ),
    [documentList.data],
  );
  const tree = useMemo(() => buildDocTree(documents), [documents]);

  useEffect(() => {
    if (documentList.data?.status !== "ready") return;
    if (documents.length === 0) {
      if (activeDoc !== "") onActiveDocChange("");
      return;
    }
    if (!documents.some((document) => document.path === activeDoc)) onActiveDocChange(documents[0]!.path);
  }, [activeDoc, documentList.data?.status, documents, onActiveDocChange]);

  // 头部行不随树滚动(控件要一直在);树体在窗内自己滚,展开大树不扩大外层区域。
  return (
    <nav
      aria-label="任务包文件"
      className="flex min-h-0 min-w-0 flex-col border-b border-border bg-surface @min-[1100px]:border-r @min-[1100px]:border-b-0"
      data-testid="task-document-tree"
    >
      <div className="flex shrink-0 items-center gap-1 px-2 py-1">
        <RegionDragHandle />
        <p className="min-w-0 truncate font-mono ui-micro font-semibold uppercase tracking-[0.16em] text-text-faint">
          Task 文件
        </p>
        <span className="ml-auto shrink-0">
          <RegionLayoutControls />
        </span>
        {props.headerExtra ? <span className="ml-auto flex shrink-0 items-center">{props.headerExtra}</span> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3" data-testid="task-document-tree-scroll">
        {tree.length === 0 ? (
          <p className="border border-dashed border-border px-2 py-3 ui-meta leading-5 text-text-faint">
            {documentList.isPending
              ? "正在读取任务包文件清单…"
              : documentList.isError
                ? `文件清单读取失败：${documentList.error.message}`
                : "投影没有返回任务包文件。"}
          </p>
        ) : (
          <DocTree nodes={tree} activeDoc={activeDoc} onSelectDoc={onOpenDoc} />
        )}
      </div>
    </nav>
  );
}

export function TaskFilesTab({
  task,
  activeDoc,
  onOpenDoc,
  onNavigateEntity,
}: {
  readonly task: TaskRow;
  readonly activeDoc: string;
  /** 包内相对链接的导航出口(task_89d324b5):正文里点 `artifacts/x.md` 直接切到该文件。 */
  readonly onOpenDoc?: (path: string) => void;
  /** 面包屑里的任务编号经 EntityRefLink 激活(G10);不提供回调时退回纯文本。 */
  readonly onNavigateEntity?: (ref: string) => void;
}) {
  return (
    <section className="min-w-0" data-testid="task-files-tab">
      <div className="mb-4 flex flex-wrap items-center gap-1.5 border-b border-border pb-3">
        {onNavigateEntity ? (
          <EntityRefLink
            entityRef={entityRefOf("task", task.taskId)}
            onNavigate={onNavigateEntity}
            className="font-mono ui-micro text-text-faint hover:underline"
          />
        ) : (
          <span className="font-mono ui-micro text-text-faint">{task.taskId}</span>
        )}
        <CaretRight weight="bold" className="ui-micro text-text-faint" />
        <span className="font-mono ui-micro text-text-muted">{activeDoc || "未选择文件"}</span>
      </div>
      <TaskFileBody
        repoId={task.projectId}
        taskId={task.taskId}
        path={activeDoc || null}
        packagePath={task.packagePath ?? null}
        onOpenDoc={onOpenDoc}
      />
    </section>
  );
}

interface TaskFileBodyProps {
  readonly repoId: string;
  readonly taskId: string;
  readonly path: string | null;
  /** 台账上的任务包路径(`tasks/<pkg>`);相对链接据此落回包内。 */
  readonly packagePath: string | null;
  readonly onOpenDoc?: (path: string) => void;
}

function TaskFileBody({ repoId, taskId, path, packagePath, onOpenDoc }: TaskFileBodyProps) {
  const document = useTaskDocumentQuery(repoId, taskId, path);
  if (!path) return <FileEmpty text="先从左侧选择一个任务包文件。" />;
  if (document.isPending) return <FileEmpty text="正在读取文档投影…" />;
  if (document.isError) return <p className="ui-meta text-danger">文档读取失败：{document.error.message}</p>;
  if (document.data.status !== "ready") return <FileEmpty text="文档投影尚未追平。" />;
  // 二进制产物没有正文:把空 body 交给 DocReader 就是一张白页,读者分不清「不是文本」和
  // 「空文件」。改为如实报出媒体类型、字节数、内容地址与取字节的路径。
  if (document.data.contentKind === "binary")
    return (
      <BinaryArtifactPanel repoId={repoId} taskId={taskId} path={path} packagePath={packagePath} read={document.data} />
    );
  // 工作树实时内容优先(task_e5defe69):未提交的编辑是真实工作,必须可见并被标注,
  // 而不是把读者留在已提交的旧文里;文件只在投影里(磁盘上已删)时如实回落到投影文。
  const uncommitted = document.data.uncommitted,
    body = uncommitted && document.data.worktreeBody !== null ? document.data.worktreeBody : document.data.body;
  if (document.data.blobSha256 === null && document.data.worktreeBody === null)
    return <FileEmpty text="该文件尚未物化。" />;
  const content = isHtmlDocument(path) ? (
    <HtmlArtifactPreview content={body} path={path} />
  ) : (
    <DocReader
      content={body}
      packageBasePath={packagePath !== null && path !== null ? `${packagePath}/${path}` : null}
      onOpenPackageDoc={onOpenDoc}
    />
  );
  return (
    <>
      <span data-testid="task-document-status" className="mb-3 block font-mono ui-micro text-text-faint">
        {uncommitted ? "L2 · 工作树未提交" : `L2 · ${document.data.status}`}
      </span>
      {uncommitted && (
        <p
          data-testid="task-document-uncommitted"
          className={[
            "mb-3 border border-status-blocked/40 bg-status-blocked/10",
            "px-2.5 py-1.5 ui-micro text-status-blocked",
          ].join(" ")}
        >
          工作树内容尚未提交:以下为磁盘当前内容,与已提交投影不同。
        </p>
      )}
      {content}
    </>
  );
}

function FileEmpty({ text }: { readonly text: string }) {
  return (
    <div
      className={[
        "flex min-h-56 flex-col items-center justify-center gap-2",
        "border border-dashed border-border-strong px-6 text-center",
      ].join(" ")}
    >
      <FileText weight="duotone" className="text-2xl text-text-faint" />
      <p className="ui-meta text-text-faint">{text}</p>
    </div>
  );
}
