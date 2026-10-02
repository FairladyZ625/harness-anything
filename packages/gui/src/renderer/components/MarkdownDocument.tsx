import { isValidElement, useEffect, useMemo, useState } from "react";
import type { Components } from "react-markdown";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
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
          if (childProps.className?.includes("language-mermaid"))
            return (
              <MermaidDiagram
                key={String(childProps.children ?? "")}
                source={String(childProps.children ?? "").trim()}
              />
            );
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
    <Markdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={components}
      urlTransform={markdownUrlTransform}
    >
      {content}
    </Markdown>
  );
}

function MermaidDiagram({ source }: { readonly source: string }) {
  const [markup, setMarkup] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "base" });
        const rendered = await mermaid.render(`diagram-${crypto.randomUUID()}`, source);
        if (!cancelled) setMarkup(rendered.svg);
      })
      .catch((cause) => {
        console.error("Mermaid diagram rendering failed:", cause);
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [source]);
  if (markup !== null)
    return (
      <div
        className="document-wide-block my-4 overflow-auto rounded-md border border-border bg-surface p-3"
        dangerouslySetInnerHTML={{ __html: markup }}
      />
    );
  if (error !== null)
    return (
      <pre className="document-wide-block my-4 overflow-auto rounded-md border border-danger/40 bg-surface p-3 font-mono ui-meta text-danger">
        {source}\n\n图表渲染失败：{error}
      </pre>
    );
  return (
    <pre className="document-wide-block my-4 overflow-auto rounded-md border border-border bg-surface p-3 font-mono ui-meta text-text-muted">
      {source}
    </pre>
  );
}
