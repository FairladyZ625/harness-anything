import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CaretDown, CaretRight, File, FilePdf, Folder } from "@phosphor-icons/react";
import { entityLocatorContentQuery, repoDirectoryQuery } from "../../entity-locator-client.ts";
import {
  isHtmlDocument,
  isMarkdownDocument,
  isPdfDocument,
  type EntityLocator,
} from "../../entity-locator-renderer.ts";
import { DocReader } from "../DocReader.tsx";
import { HtmlArtifactPreview } from "../HtmlArtifactPreview.tsx";
import { PdfLocatorCard } from "./PdfLocatorCard.tsx";

/**
 * 目录 locator 的阅读面(task_a494eac2 Goal 2):一棵**懒展开**的文件树 + 内嵌查看器。
 *
 * 旧实现只列 locator 目录的一层,且把全路径分段建树后只展开第 0 层——用户看到的
 * 永远是 `harness/ > context/` 两级壳,要点四层才到文件,而更深的层根本没读。这里
 * 树根就钉在实体目录上,子目录展开时才对子路径发同一条 `repo.entity.locator.read`
 * (不新增 daemon 能力),点文件在右栏按渲染器选择表打开。
 */
export function EntityDirectoryBrowser({
  repoId,
  locator,
}: {
  readonly repoId: string;
  readonly locator: EntityLocator;
}) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="entity-locator-directory">
      <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-border">
        <p className="sticky top-0 border-b border-border bg-surface px-2 py-1.5 break-all font-mono ui-micro text-text-faint">
          {locator.value}/
        </p>
        <DirectoryChildren
          repoId={repoId}
          directoryPath={locator.value.replace(/\/$/u, "")}
          depth={0}
          selectedFile={selectedFile}
          onSelectFile={setSelectedFile}
        />
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selectedFile === null ? (
          <p className="flex flex-1 items-center justify-center p-6 text-center ui-meta text-text-faint">
            从左侧点开一个文件,内容在这里渲染。
          </p>
        ) : (
          <DirectoryFileViewer repoId={repoId} path={selectedFile} />
        )}
      </div>
    </div>
  );
}

/** 一层目录的条目:目录行可再展开(展开才读),文件行点击打开。 */
function DirectoryChildren({
  repoId,
  directoryPath,
  depth,
  selectedFile,
  onSelectFile,
}: {
  readonly repoId: string;
  readonly directoryPath: string;
  readonly depth: number;
  readonly selectedFile: string | null;
  readonly onSelectFile: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([directoryPath]));
  const read = useQuery(repoDirectoryQuery(repoId, directoryPath));
  if (read.isPending) return <p className="px-2 py-1 font-mono ui-micro text-text-faint">读取中…</p>;
  if (read.isError)
    return (
      <p className="px-2 py-1 font-micro ui-micro text-status-blocked">
        读取失败:{read.error instanceof Error ? read.error.message : String(read.error)}
      </p>
    );
  if (read.data.outcome !== "directory")
    return (
      <p className="px-2 py-1 ui-micro text-status-blocked">
        {directoryPath} 不是可列举的目录({read.data.outcome})。
      </p>
    );
  const entries = [...read.data.entries].sort((left, right) => {
    if (left.directory !== right.directory) return left.directory ? -1 : 1;
    return segmentName(left.path).localeCompare(segmentName(right.path));
  });
  return (
    <>
      {read.data.truncated && <p className="px-2 py-1 ui-micro text-text-faint">条目过多,只列前 500 条。</p>}
      {entries.length === 0 && <p className="px-2 py-1 ui-micro text-text-faint">空目录。</p>}
      {entries.map(({ path, directory }) =>
        directory ? (
          <div key={path}>
            <button
              type="button"
              data-testid={`entity-directory-node-${path}`}
              aria-expanded={expanded.has(path)}
              onClick={() =>
                setExpanded((previous) => {
                  const next = new Set(previous);
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  return next;
                })
              }
              className="flex w-full items-center gap-1 py-0.5 pr-2 text-left font-mono ui-micro text-text-muted hover:text-text"
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
              <DirectoryChildren
                repoId={repoId}
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
            data-testid={`entity-directory-node-${path}`}
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

/** 树内文件的查看器:与实体正文同一张渲染器选择表,不另立判据。 */
function DirectoryFileViewer({ repoId, path }: { readonly repoId: string; readonly path: string }) {
  const read = useQuery(entityLocatorContentQuery(repoId, { kind: "repository-path", value: path }));
  if (read.isPending) return <p className="p-4 ui-meta text-text-faint">读取 {path} …</p>;
  if (read.isError)
    return (
      <p data-testid="entity-directory-file-error" className="p-4 ui-meta text-status-blocked">
        读取失败:{read.error instanceof Error ? read.error.message : String(read.error)}
      </p>
    );
  const content = read.data;
  if (content.outcome !== "file")
    return (
      <div className="p-4" data-testid="entity-directory-file-note">
        <p className="break-all font-mono ui-micro text-text-muted">{path}</p>
        <p className="mt-1 ui-meta text-text-faint">
          {content.outcome === "missing"
            ? "这个文件在工作区里不存在了。"
            : content.outcome === "binary"
              ? "二进制文件,GUI 读面不载正文。"
              : content.outcome === "too-large"
                ? "超过阅读面上限,不在 GUI 内展开。"
                : "这个指针读不出可渲染的正文。"}
        </p>
      </div>
    );
  if (isPdfDocument(path)) return <PdfLocatorCard path={path} />;
  if (isHtmlDocument(path))
    return (
      <div className="min-h-0 flex-1" data-testid="entity-directory-file-html">
        <HtmlArtifactPreview fillAvailable content={content.content ?? ""} path={path} />
      </div>
    );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="entity-directory-file-markdown">
      <DocReader content={content.content ?? ""} />
    </div>
  );
}

function segmentName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}
