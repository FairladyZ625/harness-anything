import { useEffect, useState } from "react";
import { CaretRight, CaretDown } from "@phosphor-icons/react";
import type { DocTreeNode } from "../../model/docTree.ts";
import { collectDirectoryPaths } from "../../model/docTree.ts";
import { DocPresence } from "./widgets.tsx";
import { t } from "../../i18n/index.tsx";

/**
 * 文档路径分段树(替代原来的 6-组扁平分组)。
 *
 * 支持展开 artifacts/ 及更深子目录。目录节点可折叠,文件节点点击选中。
 * 默认展开根级目录,让用户一眼看到主要分区;嵌套目录折叠(避免过长)。
 */
interface DocTreeProps {
  nodes: DocTreeNode[];
  activeDoc: string;
  onSelectDoc: (path: string) => void;
}

export function DocTree({ nodes, activeDoc, onSelectDoc }: DocTreeProps) {
  // 默认展开根级目录(depth 0),让用户一眼看到主要分区。
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    new Set(collectDirectoryPaths(nodes, 0)),
  );

  // 切换任务 / 文档清单刷新时,重置展开态到默认。
  useEffect(() => {
    setExpanded(new Set(collectDirectoryPaths(nodes, 0)));
  }, [nodes]);

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (nodes.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border px-2 py-3 text-[12px] text-text-faint">
        {t("components.docTree.projectionDidNotReturnDocumentList")}</div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {nodes.map((node) => (
        <TreeNodeView
          key={node.path}
          node={node}
          depth={0}
          expanded={expanded}
          activeDoc={activeDoc}
          onToggle={toggle}
          onSelectDoc={onSelectDoc}
        />
      ))}
    </div>
  );
}

function TreeNodeView({
  node,
  depth,
  expanded,
  activeDoc,
  onToggle,
  onSelectDoc,
}: {
  node: DocTreeNode;
  depth: number;
  expanded: Set<string>;
  activeDoc: string;
  onToggle: (path: string) => void;
  onSelectDoc: (path: string) => void;
}) {
  const isExpanded = expanded.has(node.path);
  const indent = depth * 12 + 4;

  if (node.isDir) {
    return (
      <>
        <button
          onClick={() => onToggle(node.path)}
          className="flex w-full items-center gap-1 rounded-md py-1 pr-2 text-left text-[12px] font-medium text-text-muted hover:text-text"
          style={{ paddingLeft: indent }}
        >
          {isExpanded ? (
            <CaretDown weight="bold" className="shrink-0 text-[10px] text-text-faint" />
          ) : (
            <CaretRight weight="bold" className="shrink-0 text-[10px] text-text-faint" />
          )}
          <span className="min-w-0 truncate">{node.name}/</span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-text-faint">
            {countDocs(node)}
          </span>
        </button>
        {isExpanded &&
          node.children.map((child) => (
            <TreeNodeView
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              activeDoc={activeDoc}
              onToggle={onToggle}
              onSelectDoc={onSelectDoc}
            />
          ))}
      </>
    );
  }

  const doc = node.doc;
  if (!doc) return null;

  return (
    <button
      onClick={() => onSelectDoc(doc.path)}
      className={`flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[13px] ${
        activeDoc === doc.path
          ? "bg-surface-raised text-text"
          : "text-text-muted hover:text-text"
      }`}
      style={{ paddingLeft: indent + 14 }}
    >
      <DocPresence doc={doc} />
      <span className="min-w-0 truncate">{doc.title}</span>
      {doc.required && (
        <span className="shrink-0 rounded border border-border px-1 text-[9px] text-text-faint">
          {t("components.docTree.required")}</span>
      )}
      {!doc.present && doc.required && (
        <span
          className="shrink-0 text-[10px]"
          style={{ color: "var(--color-danger)" }}
        >
          {t("components.docTree.missing")}</span>
      )}
    </button>
  );
}

/** 递归统计目录下的文件数(含子目录)。 */
function countDocs(node: DocTreeNode): number {
  if (!node.isDir) return 0;
  let count = 0;
  for (const child of node.children) {
    if (child.isDir) count += countDocs(child);
    else count++;
  }
  return count;
}
