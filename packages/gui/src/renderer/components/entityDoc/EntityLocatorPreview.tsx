import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowSquareOut, FolderOpen } from "@phosphor-icons/react";
import { DocReader } from "../DocReader.tsx";
import { HtmlArtifactPreview } from "../HtmlArtifactPreview.tsx";
import { DocTree } from "../taskDetail/DocTree.tsx";
import { buildDocTree } from "../../model/docTree.ts";
import type { DocEntry } from "../../model/types.ts";
import { entityLocatorContentQuery } from "../../entity-locator-client.ts";
import { selectEntityLocatorRenderer, type EntityLocator } from "../../entity-locator-renderer.ts";
import { openArtifactExternally } from "../../artifact-open-client.ts";

/**
 * 实体 locator 的渲染面。渲染器由 `selectEntityLocatorRenderer` 的那张表选,本文件不再
 * 按扩展名判第二次;三种渲染器都是仓里既有的实现(DocReader / HtmlArtifactPreview /
 * DocTree),这里只负责喂数据。认不出来的指针显示元数据卡 + 「在系统中打开」——
 * 不假装能渲染。
 */
export function EntityLocatorPreview({
  repoId,
  locator,
}: {
  readonly repoId: string;
  readonly locator: EntityLocator;
}) {
  const renderer = selectEntityLocatorRenderer(locator);
  const read = useQuery(entityLocatorContentQuery(repoId, locator));

  if (renderer === "opaque")
    return <OpaqueLocator repoId={repoId} locator={locator} note="这个指针没有对应的 GUI 渲染器。" />;
  if (read.isPending) return <PreviewNote testId="entity-locator-pending" text={`读取 ${locator.value} …`} />;
  if (read.isError) return <PreviewNote testId="entity-locator-failed" text={`读取失败:${read.error.message}`} />;

  const content = read.data;
  if (content.outcome !== "file" && content.outcome !== "directory")
    return <OpaqueLocator repoId={repoId} locator={locator} note={outcomeNote(content.outcome, content.path)} />;

  if (renderer === "directory" || content.outcome === "directory")
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="entity-locator-directory">
        {content.truncated && <p className="px-3 py-1 ui-micro text-text-faint">条目过多,只列前 500 条。</p>}
        <DocTree nodes={buildDocTree(content.entries.map(docEntryOf))} activeDoc="" onSelectDoc={() => {}} />
      </div>
    );

  if (renderer === "html")
    return (
      <div className="min-h-0 flex-1" data-testid="entity-locator-html">
        <HtmlArtifactPreview fillAvailable content={content.content ?? ""} path={content.path} />
      </div>
    );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="entity-locator-markdown">
      <DocReader content={content.content ?? ""} />
    </div>
  );
}

/**
 * 目录条目 → 文件树节点。目录指针只列一层;`group`/`required` 是 DocEntry 的必填字段
 * 而文件树本身不消费它们(树按路径分段建),所以这里给中性值,不冒充任务包语义。
 */
function docEntryOf(entry: { readonly path: string; readonly directory: boolean }): DocEntry {
  return {
    path: entry.path,
    title: entry.path.split("/").at(-1) ?? entry.path,
    group: "证据",
    required: false,
    present: true,
    presence: "present",
  };
}

function outcomeNote(outcome: string, path: string): string {
  if (outcome === "missing") return `${path} 在工作区里不存在——描述符还在,正文不在了。`;
  if (outcome === "too-large") return `${path} 超过阅读面上限,不在 GUI 内展开。`;
  if (outcome === "binary") return `${path} 是二进制文件,不在 GUI 内展开。`;
  return `${path} 不是仓内路径指针。`;
}

/**
 * 元数据卡 + 「在系统中打开」。外部打开走既有的 `harness:artifacts:openExternal` 通道——
 * 那条通道的路径面是收窄过的(只接 task 包 artifacts/ 下的 html/md),拒绝时把它返回的
 * 理由原样显示,不在渲染层放宽主进程的边界,也不假装打开成功了。
 */
function OpaqueLocator({
  repoId,
  locator,
  note,
}: {
  readonly repoId: string;
  readonly locator: EntityLocator;
  readonly note: string;
}) {
  const [openError, setOpenError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2 p-4" data-testid="entity-locator-opaque">
      <div className="flex items-center gap-2 ui-meta text-text-muted">
        <FolderOpen weight="bold" className="text-text-faint" />
        <span className="font-mono ui-micro">{locator.kind}</span>
      </div>
      <p className="break-all font-mono ui-meta text-text">{locator.value}</p>
      <p className="ui-meta text-text-faint">{note}</p>
      {locator.kind === "repository-path" && (
        <button
          type="button"
          data-testid="entity-locator-open-external"
          onClick={() => {
            void openArtifactExternally({ repoId, path: locator.value }).then((result) =>
              setOpenError(result.ok ? null : (result.error ?? "打开失败。")),
            );
          }}
          className={[
            "inline-flex w-fit items-center gap-1 rounded-md border border-border px-2 py-1 ui-meta text-text-muted",
            "hover:border-border-strong hover:text-text",
          ].join(" ")}
        >
          <ArrowSquareOut weight="bold" />
          在系统中打开
        </button>
      )}
      {openError !== null && (
        <p data-testid="entity-locator-open-error" className="ui-meta text-status-blocked">
          {openError}
        </p>
      )}
    </div>
  );
}

function PreviewNote({ text, testId }: { readonly text: string; readonly testId: string }) {
  return (
    <p data-testid={testId} className="p-4 ui-meta text-text-faint">
      {text}
    </p>
  );
}
