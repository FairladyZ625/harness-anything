import { useEffect, useMemo } from "react";
import { CaretRight, FileText } from "@phosphor-icons/react";
import { DocReader } from "../DocReader.tsx";
import { HtmlArtifactPreview } from "../HtmlArtifactPreview.tsx";
import { buildDocTree, projectedDocuments } from "../../model/docTree.ts";
import type { TaskRow } from "../../model/types.ts";
import { useTaskDocumentListQuery, useTaskDocumentQuery } from "../../task-data.ts";
import { DocTree } from "./DocTree.tsx";

interface TaskDocumentSidebarProps {
  readonly task: TaskRow;
  readonly activeDoc: string;
  readonly onActiveDocChange: (path: string) => void;
  readonly onOpenDoc: (path: string) => void;
}

export function TaskDocumentSidebar({
  task,
  activeDoc,
  onActiveDocChange,
  onOpenDoc,
}: TaskDocumentSidebarProps) {
  const documentList = useTaskDocumentListQuery(task.projectId, task.taskId);
  const documents = useMemo(() => {
    const projected = documentList.data?.status === "ready"
      ? documentList.data.documents.map((document) => document.path)
      : [];
    return projectedDocuments(projected);
  }, [documentList.data]);
  const tree = useMemo(() => buildDocTree(documents), [documents]);

  useEffect(() => {
    if (documentList.data?.status !== "ready") return;
    if (documents.length === 0) {
      if (activeDoc !== "") onActiveDocChange("");
      return;
    }
    if (!documents.some((document) => document.path === activeDoc)) onActiveDocChange(documents[0]!.path);
  }, [activeDoc, documentList.data?.status, documents, onActiveDocChange]);

  return (
    <nav
      aria-label="任务包文件"
      className="min-h-0 overflow-y-auto border-b border-border bg-surface p-3 md:border-r md:border-b-0"
      data-testid="task-document-tree"
    >
      <p className="mb-2 px-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-text-faint">
        Task 文件
      </p>
      {tree.length === 0 ? (
        <p className="border border-dashed border-border px-2 py-3 text-[12px] leading-5 text-text-faint">
          {documentList.isPending
            ? "正在读取任务包文件清单…"
            : documentList.isError
              ? `文件清单读取失败：${documentList.error.message}`
              : "投影没有返回任务包文件。"}
        </p>
      ) : (
        <DocTree nodes={tree} activeDoc={activeDoc} onSelectDoc={onOpenDoc} />
      )}
    </nav>
  );
}

export function TaskFilesTab({ task, activeDoc }: { readonly task: TaskRow; readonly activeDoc: string }) {
  return (
    <section className="min-w-0" data-testid="task-files-tab">
      <div className="mb-4 flex flex-wrap items-center gap-1.5 border-b border-border pb-3">
        <span className="font-mono text-[11px] text-text-faint">{task.taskId}</span>
        <CaretRight weight="bold" className="text-[10px] text-text-faint" />
        <span className="font-mono text-[11px] text-text-muted">{activeDoc || "未选择文件"}</span>
      </div>
      <TaskFileBody repoId={task.projectId} taskId={task.taskId} path={activeDoc || null} />
    </section>
  );
}

interface TaskFileBodyProps {
  readonly repoId: string;
  readonly taskId: string;
  readonly path: string | null;
}

function TaskFileBody({ repoId, taskId, path }: TaskFileBodyProps) {
  const document = useTaskDocumentQuery(repoId, taskId, path);
  if (!path) return <FileEmpty text="先从左侧选择一个任务包文件。" />;
  if (document.isPending) return <FileEmpty text="正在读取文档投影…" />;
  if (document.isError) return <p className="text-[12px] text-danger">文档读取失败：{document.error.message}</p>;
  if (document.data.status !== "ready") return <FileEmpty text="文档投影尚未追平。" />;
  if (document.data.blobSha256 === null) return <FileEmpty text="该文件尚未物化。" />;
  const content = isHtmlDocument(path)
    ? <HtmlArtifactPreview content={document.data.body} path={path} />
    : <DocReader content={document.data.body} />;
  return (
    <>
      <span
        data-testid="task-document-status"
        className="mb-3 block font-mono text-[10px] text-text-faint"
      >
        L2 · {document.data.status}
      </span>
      {content}
    </>
  );
}

export function isHtmlDocument(path: string): boolean {
  return /\.html?$/iu.test(path);
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
      <p className="text-[12px] text-text-faint">{text}</p>
    </div>
  );
}
