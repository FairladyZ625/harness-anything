import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from "react";
import { classifyMarkdownHref } from "./markdown-links.ts";
import { useLocalDocOpener } from "./local-doc-context.ts";
import { t } from "../i18n/index.tsx";

/**
 * Markdown 渲染的统一锚点(task_89d324b5):react-markdown 的 `a` 组件覆盖,
 * DocReader 与 Decision 正文共用一份。
 *
 * 根修就在这一行 `event.preventDefault()`:渲染层的 Markdown 锚点永远不做文档导航。
 * 此前绝对路径链接(`/Users/…`)在 dev 壳里解析到 dev origin 之下,点击把窗口带离
 * 应用、落在 dev server 404 上(整页白屏);打包态则被壳拒成死链接。现在点击按
 * classifyMarkdownHref 归类:本机文件 → 本机文档浮层;包内相对路径 → 宿主提供的
 * 包内文档导航;网页/其它 → 不打开,给出可读的 tooltip 说明。
 */
export interface MarkdownAnchorProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  readonly children?: ReactNode;
  /** react-markdown 传入的 AST 节点;显式摘掉,不泄漏到 DOM。 */
  readonly node?: unknown;
  /** 当前文档在任务包内的 repo 相对路径;提供时相对链接才有包内落点。 */
  readonly packageBasePath?: string | null;
  /** 包内文档导航出口(收到归一化后的 repo 相对路径)。 */
  readonly onOpenPackageDoc?: (repoRelativePath: string) => void;
}

export function MarkdownAnchor({
  href,
  children,
  node: _node,
  packageBasePath,
  onOpenPackageDoc,
  ...rest
}: MarkdownAnchorProps) {
  const opener = useLocalDocOpener();
  const target = classifyMarkdownHref(href ?? "", { packageBasePath: packageBasePath ?? null });
  const title =
    target.kind === "web"
      ? t("components.localDoc.webLinkTitle")
      : target.kind === "inert"
        ? t("components.localDoc.inertLinkTitle")
        : target.path;
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (target.kind === "local-file") opener.openLocalDocument(target.path);
    else if (target.kind === "package-doc") onOpenPackageDoc?.(target.path);
  };
  return (
    <a {...rest} href={href} title={title} onClick={handleClick} data-markdown-link={target.kind}>
      {children}
    </a>
  );
}
