import { isValidElement, useMemo } from "react";
import type { Components } from "react-markdown";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MarkdownAnchor } from "../local-doc/MarkdownAnchor.tsx";
import { markdownUrlTransform } from "../local-doc/markdown-links.ts";

/** The single markdown surface used by task, decision, review and local documents. */
export function MarkdownDocument({
  content,
  packageBasePath = null,
  onOpenPackageDoc,
}: {
  readonly content: string;
  readonly packageBasePath?: string | null;
  readonly onOpenPackageDoc?: (repoRelativePath: string) => void;
}) {
  const components = useMemo<Components>(() => {
    const value: Components = {
      table({ node: _node, children, ...props }) {
        return (
          <div className="document-wide-block">
            <table {...props}>{children}</table>
          </div>
        );
      },
      pre({ node: _node, children }) {
        if (isValidElement(children)) {
          const childProps = children.props as { className?: string; children?: unknown };
          if (childProps.className?.includes("language-mermaid")) {
            return (
              <pre className="my-4 overflow-x-auto rounded-md border border-border bg-surface p-3 font-mono ui-meta text-text-muted">
                <code>{String(childProps.children ?? "").trim()}</code>
              </pre>
            );
          }
        }
        return (
          <div className="document-wide-block">
            <pre>{children}</pre>
          </div>
        );
      },
      a: (props) => <MarkdownAnchor {...props} packageBasePath={packageBasePath} onOpenPackageDoc={onOpenPackageDoc} />,
    };
    return value;
  }, [onOpenPackageDoc, packageBasePath]);

  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components} urlTransform={markdownUrlTransform}>
      {content}
    </Markdown>
  );
}
