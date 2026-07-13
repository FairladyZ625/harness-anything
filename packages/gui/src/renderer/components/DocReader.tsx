import { isValidElement, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { t } from "../i18n/index.tsx";

// mermaid diagram rendering is intentionally omitted in the Electron shell:
// its runtime injects inline <style>/<script>, which the production CSP
// (style-src 'self'; script-src 'self') blocks, and the bundle is heavy.
// mermaid code fences fall back to a readable source block.
const components: Components = {
  pre({ node: _node, children }) {
    if (isValidElement(children)) {
      const childProps = children.props as {
        className?: string;
        children?: ReactNode;
      };
      if (childProps.className?.includes("language-mermaid")) {
        return (
          <pre className="my-4 overflow-x-auto rounded-md border border-border bg-surface p-3 font-mono text-[12px] text-text-muted">
            <code>{String(childProps.children ?? "").trim()}</code>
          </pre>
        );
      }
    }
    return <pre>{children}</pre>;
  },
};

export function DocReader({ content }: { content: string }) {
  const [query, setQuery] = useState("");

  const matchCount = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return content.toLowerCase().split(q).length - 1;
  }, [content, query]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="flex w-56 items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1">
          <MagnifyingGlass
            weight="bold"
            className="shrink-0 text-[12px] text-text-faint"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("components.docReader.searchWithinDocuments")}
            className="w-full bg-transparent text-[12px] text-text outline-none placeholder:text-text-faint"
          />
        </div>
        {matchCount !== null && (
          <span
            className={`shrink-0 font-mono text-[11px] ${
              matchCount > 0 ? "text-text-muted" : "text-text-faint"
            }`}
          >
            {matchCount} {t("components.docReader.matchEverywhere")}</span>
        )}
      </div>
      <div className="prose-harness">
        <Markdown remarkPlugins={[remarkGfm]} components={components}>
          {content}
        </Markdown>
      </div>
    </div>
  );
}
