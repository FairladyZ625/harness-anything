import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CaretDown, CaretRight, File, FilePdf, Folder } from "@phosphor-icons/react";
import { entityContentQuery, soleContentFile, type EntityContentRead } from "../../entity-content-client.ts";
import {
  isHtmlDocument,
  isMarkdownDocument,
  isPdfDocument,
  selectContentRenderer,
} from "../../entity-locator-renderer.ts";
import { DocReader } from "../DocReader.tsx";
import { HtmlArtifactPreview } from "../HtmlArtifactPreview.tsx";
import { PdfLocatorCard } from "./PdfLocatorCard.tsx";

/**
 * 实体正文:它自己收管的那份内容。
 *
 * 导入被接受的那一刻,来源的字节就成了这个实体的东西;这一屏读的是**那份**,不是来源
 * 路径此刻的样子。来源被改名、移走或删掉,这里照常打开。位置由读面按当前配置算好,这里
 * 只显示,不拼路径。
 *
 * 一份来源文件的实体一打开就是正文;收了一个目录的实体给一棵懒展开的树,点哪层读哪层。
 */
export function EntityManagedContent({
  repoId,
  entityKind,
  entityId,
}: {
  readonly repoId: string;
  readonly entityKind: string;
  readonly entityId: string;
}) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const root = useQuery(entityContentQuery(repoId, entityKind, entityId));
  if (root.isPending) return <ContentNote testId="entity-managed-content-pending" text="读取这个实体收管的内容…" />;
  if (root.isError)
    return (
      <ContentNote
        testId="entity-managed-content-failed"
        text={`读取失败:${root.error instanceof Error ? root.error.message : String(root.error)}`}
      />
    );

  const content = root.data;
  if (content.outcome !== "directory")
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="entity-managed-content">
        <ContentLocation content={content} />
        <ContentBody repoId={repoId} entityKind={entityKind} entityId={entityId} path="" />
      </div>
    );

  const opened = selectedFile ?? soleContentFile(content.entries);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="entity-managed-content">
      <ContentLocation content={content} />
      <div className="flex min-h-0 min-w-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-border">
          <ContentChildren
            repoId={repoId}
            entityKind={entityKind}
            entityId={entityId}
            directoryPath=""
            depth={0}
            selectedFile={opened}
            onSelectFile={setSelectedFile}
          />
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {opened === null ? (
            <p className="flex flex-1 items-center justify-center p-6 text-center ui-meta text-text-faint">
              从左侧点开一个文件,正文在这里渲染。
            </p>
          ) : (
            <ContentBody repoId={repoId} entityKind={entityKind} entityId={entityId} path={opened} />
          )}
        </div>
      </div>
    </div>
  );
}

/** 内容在仓里的位置。`repositoryPath` 是读面按当前 authored root 算出来的,渲染层不拼前缀。 */
function ContentLocation({ content }: { readonly content: EntityContentRead }) {
  return (
    <p
      data-testid="entity-managed-content-path"
      className="shrink-0 border-b border-border px-3 py-1.5 break-all font-mono ui-micro text-text-faint"
    >
      {content.repositoryPath}
    </p>
  );
}

/** 一层内容的条目。目录展开时才对那一层再发同一条读,不预取整棵树。 */
function ContentChildren({
  repoId,
  entityKind,
  entityId,
  directoryPath,
  depth,
  selectedFile,
  onSelectFile,
}: {
  readonly repoId: string;
  readonly entityKind: string;
  readonly entityId: string;
  readonly directoryPath: string;
  readonly depth: number;
  readonly selectedFile: string | null;
  readonly onSelectFile: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const read = useQuery(entityContentQuery(repoId, entityKind, entityId, directoryPath));
  if (read.isPending) return <p className="px-2 py-1 font-mono ui-micro text-text-faint">读取中…</p>;
  if (read.isError)
    return (
      <p className="px-2 py-1 ui-micro text-status-blocked">
        读取失败:{read.error instanceof Error ? read.error.message : String(read.error)}
      </p>
    );
  if (read.data.outcome !== "directory")
    return <p className="px-2 py-1 ui-micro text-text-faint">这一层不是目录({read.data.outcome})。</p>;
  const entries = [...read.data.entries].sort((left, right) => {
    if (left.directory !== right.directory) return left.directory ? -1 : 1;
    return segmentName(left.path).localeCompare(segmentName(right.path));
  });
  return (
    <>
      {read.data.truncated && <p className="px-2 py-1 ui-micro text-text-faint">条目过多,只列前 500 条。</p>}
      {entries.length === 0 && <p className="px-2 py-1 ui-micro text-text-faint">这一层没有内容。</p>}
      {entries.map(({ path, directory }) =>
        directory ? (
          <div key={path}>
            <button
              type="button"
              data-testid={`entity-content-node-${path}`}
              aria-expanded={expanded.has(path)}
              onClick={() =>
                setExpanded((previous) => {
                  const next = new Set(previous);
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  return next;
                })
              }
              className={[
                "flex w-full items-center gap-1 py-0.5 pr-2 text-left font-mono",
                "ui-micro text-text-muted hover:text-text",
              ].join(" ")}
              style={{ paddingLeft: depth * 12 + 4 }}
            >
              {expanded.has(path) ? (
                <CaretDown weight="bold" className="shrink-0 text-text-faint" />
              ) : (
                <CaretRight weight="bold" className="shrink-0 text-text-faint" />
              )}
              <Folder weight="bold" className="shrink-0 text-text-faint" />
              <span className="min-w-0 truncate">{segmentName(path)}/</span>
            </button>
            {expanded.has(path) && (
              <ContentChildren
                repoId={repoId}
                entityKind={entityKind}
                entityId={entityId}
                directoryPath={path}
                depth={depth + 1}
                selectedFile={selectedFile}
                onSelectFile={onSelectFile}
              />
            )}
          </div>
        ) : (
          <button
            key={path}
            type="button"
            data-testid={`entity-content-node-${path}`}
            aria-current={selectedFile === path ? "page" : undefined}
            onClick={() => onSelectFile(path)}
            className={[
              "flex w-full items-center gap-1 py-0.5 pr-2 text-left font-mono ui-micro",
              selectedFile === path ? "bg-surface-raised text-text" : "text-text-muted hover:text-text",
            ].join(" ")}
            style={{ paddingLeft: depth * 12 + 18 }}
          >
            {isPdfDocument(path) ? (
              <FilePdf className="shrink-0 text-text-faint" />
            ) : isMarkdownDocument(path) || isHtmlDocument(path) ? (
              <File className="shrink-0 text-text-faint" />
            ) : (
              <File className="shrink-0 text-text-faint opacity-60" />
            )}
            <span className="min-w-0 truncate">{segmentName(path)}</span>
          </button>
        ),
      )}
    </>
  );
}

/** 一份收管内容的渲染:与来源指针共用同一张渲染器选择表,不另立判据。 */
function ContentBody({
  repoId,
  entityKind,
  entityId,
  path,
}: {
  readonly repoId: string;
  readonly entityKind: string;
  readonly entityId: string;
  readonly path: string;
}) {
  const read = useQuery(entityContentQuery(repoId, entityKind, entityId, path));
  if (read.isPending) return <ContentNote testId="entity-managed-content-body-pending" text="读取中…" />;
  if (read.isError)
    return (
      <ContentNote
        testId="entity-managed-content-body-failed"
        text={`读取失败:${read.error instanceof Error ? read.error.message : String(read.error)}`}
      />
    );
  const content = read.data;
  const renderer = selectContentRenderer(path, content.outcome);
  if (renderer === "pdf") return <PdfLocatorCard path={content.repositoryPath} />;
  if (renderer === "html")
    return (
      <div className="min-h-0 flex-1" data-testid="entity-managed-content-html">
        <HtmlArtifactPreview fillAvailable content={content.content ?? ""} path={path} />
      </div>
    );
  if (content.outcome === "file")
    return (
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="entity-managed-content-text">
        <DocReader content={content.content ?? ""} />
      </div>
    );
  return (
    <div className="flex flex-col gap-2 p-4" data-testid="entity-managed-content-note">
      <p className="break-all font-mono ui-meta text-text">{content.repositoryPath}</p>
      <p className="ui-meta text-text-faint">{outcomeNote(content)}</p>
    </div>
  );
}

function outcomeNote(content: EntityContentRead): string {
  if (content.outcome === "missing")
    return content.path === "" ? "这个实体还没有收管任何内容。" : "这条路径不在这个实体收管的内容里。";
  if (content.outcome === "too-large") return "内容超过阅读面上限,不在 GUI 内展开。";
  if (content.outcome === "binary") return `二进制内容(${content.mediaType ?? "未标注类型"}),GUI 内展不开。`;
  return "这一份内容没有对应的 GUI 渲染器。";
}

function ContentNote({ text, testId }: { readonly text: string; readonly testId: string }) {
  return (
    <p data-testid={testId} className="p-4 ui-meta text-text-faint">
      {text}
    </p>
  );
}

function segmentName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}
