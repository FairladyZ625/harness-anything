import { useQuery } from "@tanstack/react-query";
import { DocReader } from "../DocReader.tsx";
import { HtmlArtifactPreview } from "../HtmlArtifactPreview.tsx";
import { entityLocatorContentQuery } from "../../entity-locator-client.ts";
import { selectEntityLocatorRenderer, type EntityLocator } from "../../entity-locator-renderer.ts";
import { EntityDirectoryBrowser } from "./EntityDirectoryBrowser.tsx";
import { PdfLocatorCard } from "./PdfLocatorCard.tsx";

/**
 * 实体 locator 的渲染面。渲染器由 `selectEntityLocatorRenderer` 的那张表选,本文件不再
 * 按扩展名判第二次;四种渲染器都是仓里既有的实现(DocReader / HtmlArtifactPreview /
 * EntityDirectoryBrowser / PDF 事实卡),这里只负责喂数据。认不出来的指针显示元数据卡
 * ——不假装能渲染。
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

  if (renderer === "opaque") return <OpaqueLocator locator={locator} note="这个指针没有对应的 GUI 渲染器。" />;
  if (renderer === "pdf") return <PdfLocatorCard path={locator.value} />;
  if (read.isPending) return <PreviewNote testId="entity-locator-pending" text={`读取 ${locator.value} …`} />;
  if (read.isError) return <PreviewNote testId="entity-locator-failed" text={`读取失败:${read.error.message}`} />;

  const content = read.data;
  if (content.outcome !== "file" && content.outcome !== "directory")
    return <OpaqueLocator locator={locator} note={outcomeNote(content.outcome, content.path)} />;

  if (renderer === "directory" || content.outcome === "directory")
    return <EntityDirectoryBrowser repoId={repoId} locator={{ ...locator, value: content.path }} />;

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

function outcomeNote(outcome: string, path: string): string {
  if (outcome === "missing") return `${path} 在工作区里不存在——描述符还在,正文不在了。`;
  if (outcome === "too-large") return `${path} 超过阅读面上限,不在 GUI 内展开。`;
  if (outcome === "binary") return `${path} 是二进制文件,不在 GUI 内展开。`;
  return `${path} 不是仓内路径指针。`;
}

/**
 * 元数据卡。不设「在系统中打开」按钮:那条 IPC 通道只收 task 包 artifacts/ 下的
 * html/md,实体 locator 路径进不去——按下去只会得到拒绝,不如不摆。
 */
function OpaqueLocator({ locator, note }: { readonly locator: EntityLocator; readonly note: string }) {
  return (
    <div className="flex flex-col gap-2 p-4" data-testid="entity-locator-opaque">
      <div className="flex items-center gap-2 ui-meta text-text-muted">
        <span className="font-mono ui-micro">{locator.kind}</span>
      </div>
      <p className="break-all font-mono ui-meta text-text">{locator.value}</p>
      <p className="ui-meta text-text-faint">{note}</p>
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
