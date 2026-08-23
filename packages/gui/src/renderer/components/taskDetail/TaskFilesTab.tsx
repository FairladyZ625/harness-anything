import { useEffect, useMemo, useState } from "react";
import { CaretRight, FileText } from "@phosphor-icons/react";
import { DocReader } from "../DocReader.tsx";
import { buildDocTree, mergeProjectedDocuments } from "../../model/docTree.ts";
import type { TaskRow } from "../../model/types.ts";
import { useTaskDocumentListQuery, useTaskDocumentQuery } from "../../task-data.ts";
import { DocTree } from "./DocTree.tsx";

export function TaskFilesTab({ task }: { readonly task: TaskRow }) {
  const canonicalPackage = typeof task.packagePath === "string";
  const documentList = useTaskDocumentListQuery(task.projectId, canonicalPackage ? task.taskId : null);
  const documents = useMemo(() => {
    const projected = documentList.data?.status === "ready" ? documentList.data.documents.map((document) => document.path) : [];
    return mergeProjectedDocuments(canonicalPackage ? [] : task.docs, projected);
  }, [canonicalPackage, documentList.data, task.docs]);
  const tree = useMemo(() => buildDocTree(documents), [documents]);
  const [activeDoc, setActiveDoc] = useState(() => documents[0]?.path ?? task.docs[0]?.path ?? "");

  useEffect(() => {
    if (documents.length === 0) {
      if (activeDoc !== "") setActiveDoc("");
      return;
    }
    if (!documents.some((document) => document.path === activeDoc)) setActiveDoc(documents[0]!.path);
  }, [activeDoc, documents]);

  const document = documents.find((entry) => entry.path === activeDoc) ?? documents[0];
  return (
    <section className="grid min-h-[32rem] overflow-hidden border border-border md:grid-cols-[15rem_minmax(0,1fr)]" data-testid="task-files-tab">
      <nav aria-label="任务包文件" className="max-h-72 overflow-y-auto border-b border-border bg-surface p-3 md:max-h-none md:border-r md:border-b-0">
        {tree.length === 0 ? <p className="border border-dashed border-border px-2 py-3 text-[12px] leading-5 text-text-faint">
          {canonicalPackage && documentList.isPending ? "正在读取任务包文件清单…" : documentList.isError ? `文件清单读取失败：${documentList.error.message}` : "投影没有返回任务包文件。"}
        </p> : <DocTree nodes={tree} activeDoc={activeDoc} onSelectDoc={setActiveDoc} />}
      </nav>
      <article className="min-w-0 overflow-y-auto px-5 py-5 lg:px-8 lg:py-6">
        <div className="mx-auto max-w-[78ch]">
          <div className="mb-5 flex flex-wrap items-center gap-1.5 border-b border-border pb-3">
            <span className="font-mono text-[11px] text-text-faint">{task.taskId}</span>
            <CaretRight weight="bold" className="text-[10px] text-text-faint" />
            <span className="font-mono text-[11px] text-text-muted">{document?.path ?? "未选择文件"}</span>
          </div>
          <TaskFileBody repoId={task.projectId} taskId={task.taskId} path={document?.path ?? null} />
        </div>
      </article>
    </section>
  );
}

function TaskFileBody({ repoId, taskId, path }: { readonly repoId: string; readonly taskId: string; readonly path: string | null }) {
  const document = useTaskDocumentQuery(repoId, taskId, path);
  if (!path) return <FileEmpty text="先从左侧选择一个任务包文件。" />;
  if (document.isPending) return <FileEmpty text="正在读取文档投影…" />;
  if (document.isError) return <p className="text-[12px] text-danger">文档读取失败：{document.error.message}</p>;
  if (document.data.status !== "ready") return <FileEmpty text="文档投影尚未追平。" />;
  if (document.data.blobSha256 === null) return <FileEmpty text="该文件尚未物化。" />;
  return <><span data-testid="task-document-status" className="mb-3 block font-mono text-[10px] text-text-faint">L2 · {document.data.status}</span><DocReader content={document.data.body} /></>;
}

function FileEmpty({ text }: { readonly text: string }) {
  return <div className="flex min-h-56 flex-col items-center justify-center gap-2 border border-dashed border-border-strong px-6 text-center"><FileText weight="duotone" className="text-2xl text-text-faint" /><p className="text-[12px] text-text-faint">{text}</p></div>;
}
