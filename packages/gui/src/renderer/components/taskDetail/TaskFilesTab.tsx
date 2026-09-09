import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowSquareOut, CaretRight, FileText, FileX } from "@phosphor-icons/react";
import { DocReader } from "../DocReader.tsx";
import { HtmlArtifactPreview } from "../HtmlArtifactPreview.tsx";
import { buildDocTree, projectedDocuments } from "../../model/docTree.ts";
import type { TaskDocumentProjectionRead } from "../../../api/renderer-dto.ts";
import type { TaskRow } from "../../model/types.ts";
import { useTaskDocumentListQuery, useTaskDocumentQuery } from "../../task-data.ts";
import { openArtifactExternally } from "../../artifact-open-client.ts";
import { DocTree } from "./DocTree.tsx";
import { isHtmlDocument } from "../../entity-locator-renderer.ts";

interface TaskDocumentSidebarProps {
  readonly task: TaskRow;
  readonly activeDoc: string;
  readonly onActiveDocChange: (path: string) => void;
  readonly onOpenDoc: (path: string) => void;
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

  return (
    <nav
      aria-label="任务包文件"
      className="min-h-0 overflow-y-auto border-b border-border bg-surface p-3 @max-[1100px]:max-h-72 @min-[1100px]:border-r @min-[1100px]:border-b-0"
      data-testid="task-document-tree"
    >
      <p className="mb-2 px-1 font-mono ui-micro font-semibold uppercase tracking-[0.16em] text-text-faint">
        Task 文件
      </p>
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
    </nav>
  );
}

export function TaskFilesTab({
  task,
  activeDoc,
  onOpenDoc,
}: {
  readonly task: TaskRow;
  readonly activeDoc: string;
  /** 包内相对链接的导航出口(task_89d324b5):正文里点 `artifacts/x.md` 直接切到该文件。 */
  readonly onOpenDoc?: (path: string) => void;
}) {
  return (
    <section className="min-w-0" data-testid="task-files-tab">
      <div className="mb-4 flex flex-wrap items-center gap-1.5 border-b border-border pb-3">
        <span className="font-mono ui-micro text-text-faint">{task.taskId}</span>
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
      <TaskBinaryFile repoId={repoId} taskId={taskId} path={path} packagePath={packagePath} read={document.data} />
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

/** 二进制任务产物的读侧面板:元数据 + 取字节的真实路径 + 交给系统查看器打开。
 * 不在渲染进程里把字节转成字符串,也不假装它是一份空文档。 */
function TaskBinaryFile({
  repoId,
  taskId,
  path,
  packagePath,
  read,
}: {
  readonly repoId: string;
  readonly taskId: string;
  readonly path: string;
  readonly packagePath: string | null;
  readonly read: TaskDocumentProjectionRead;
}) {
  const [openError, setOpenError] = useState<string | null>(null);
  const artifactPath = packagePath === null ? null : `${packagePath}/${path}`;
  const openExternally = useCallback(async () => {
    if (artifactPath === null) return;
    setOpenError(null);
    const outcome = await openArtifactExternally({ repoId, path: artifactPath, taskId });
    if (outcome.error !== null) setOpenError(outcome.error);
  }, [artifactPath, repoId, taskId]);
  return (
    <div data-testid="task-document-binary" className="border border-border-strong">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-raised px-3 py-2">
        <FileX weight="duotone" className="text-base text-text-faint" />
        <span className="ui-meta text-text">二进制产物,不是文本</span>
        <span className="grow" />
        <button
          type="button"
          data-testid="task-document-binary-open"
          onClick={openExternally}
          disabled={artifactPath === null}
          title={artifactPath === null ? "任务包路径未知,无法定位产物文件。" : "在系统查看器中打开原始字节"}
          className={[
            "flex items-center gap-1 border border-border px-2 py-1 font-mono ui-micro",
            "text-text-muted hover:text-text disabled:opacity-50",
          ].join(" ")}
        >
          <ArrowSquareOut className="size-3" />
          打开
        </button>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 px-3 py-3 font-mono ui-micro">
        <BinaryFact label="媒体类型" value={read.mediaType ?? "未知"} />
        <BinaryFact label="字节数" value={read.size === null ? "未知" : `${read.size}`} />
        <BinaryFact label="内容地址" value={read.blobSha256 ?? "尚未入账"} />
        <BinaryFact label="仓库路径" value={read.repositoryPath} />
      </dl>
      {read.bytes === null ? (
        <p className="border-t border-border px-3 py-2 ui-micro leading-5 text-text-faint">
          字节未随本次读取返回(尚未入账,或超过内联上限);按上面的仓库路径读取原始文件。
        </p>
      ) : null}
      {openError !== null ? (
        <p className="border-t border-border px-3 py-2 ui-micro leading-5 text-danger">{openError}</p>
      ) : null}
    </div>
  );
}

function BinaryFact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <>
      <dt className="text-text-faint">{label}</dt>
      <dd className="min-w-0 break-all text-text-muted">{value}</dd>
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
