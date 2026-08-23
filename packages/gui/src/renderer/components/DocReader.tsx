import { isValidElement, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MagnifyingGlass } from "@phosphor-icons/react";

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

type ReaderLayout = "single" | "double";
type ReaderFont = "sans" | "serif" | "mono";

const readerFonts: Record<ReaderFont, string> = {
  sans: "var(--font-sans)",
  serif: 'Iowan Old Style, Palatino Linotype, Noto Serif CJK SC, serif',
  mono: "var(--font-mono)",
};

export function DocReader({ content }: { content: string }) {
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<ReaderLayout>("single");
  const [font, setFont] = useState<ReaderFont>("sans");
  const [fontSize, setFontSize] = useState(15);

  const matchCount = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return content.toLowerCase().split(q).length - 1;
  }, [content, query]);
  const readerStyle = {
    "--reader-font-family": readerFonts[font],
    "--reader-font-size": `${fontSize}px`,
  } as CSSProperties;

  return (
    <section
      className="overflow-clip rounded-lg border border-border bg-surface shadow-sm"
      data-testid="doc-reader"
      style={readerStyle}
    >
      <div className="flex min-h-10 flex-wrap items-center gap-2 border-b border-border bg-surface-raised px-3 py-2">
        <div className="flex w-56 max-w-full items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1">
          <MagnifyingGlass
            weight="bold"
            className="shrink-0 text-[12px] text-text-faint"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="文档内搜索…"
            aria-label="文档内搜索"
            className="w-full bg-transparent text-[12px] text-text outline-none placeholder:text-text-faint"
          />
        </div>
        {matchCount !== null && (
          <span
            className={`shrink-0 font-mono text-[11px] ${
              matchCount > 0 ? "text-text-muted" : "text-text-faint"
            }`}
          >
            {matchCount} 处匹配
          </span>
        )}
      </div>
      <div className="pointer-events-none sticky top-3 z-20 -mb-11 flex justify-end px-3 pt-3">
        <div
          className={[
            "pointer-events-auto flex items-center gap-1 rounded-lg border border-border-strong",
            "bg-surface-raised/95 p-1 shadow-lg backdrop-blur",
          ].join(" ")}
          data-testid="reader-floating-toolbar"
        >
          <div className="flex items-center rounded-md border border-border bg-surface p-0.5" aria-label="阅读栏数">
            {(["single", "double"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={layout === value}
                onClick={() => setLayout(value)}
                className={`rounded px-2 py-1 text-[11px] ${
                  layout === value ? "bg-accent text-accent-fg" : "text-text-muted hover:text-text"
                }`}
              >
                {value === "single" ? "单栏" : "双栏"}
              </button>
            ))}
          </div>
          <select
            aria-label="文档字体"
            value={font}
            onChange={(event) => setFont(event.target.value as ReaderFont)}
            className="h-7 rounded-md border border-border bg-surface px-1.5 text-[11px] text-text"
          >
            <option value="sans">无衬线</option>
            <option value="serif">衬线</option>
            <option value="mono">等宽</option>
          </select>
          <button
            type="button"
            aria-label="缩小字号"
            disabled={fontSize <= 13}
            onClick={() => setFontSize((size) => Math.max(13, size - 1))}
            className={[
              "grid size-7 place-items-center rounded-md text-[15px] text-text-muted",
              "hover:bg-surface hover:text-text disabled:opacity-35",
            ].join(" ")}
          >
            −
          </button>
          <span
            className="w-8 text-center font-mono text-[10px] text-text-faint"
            aria-label={`字号 ${fontSize} 像素`}
          >
            {fontSize}
          </span>
          <button
            type="button"
            aria-label="放大字号"
            disabled={fontSize >= 19}
            onClick={() => setFontSize((size) => Math.min(19, size + 1))}
            className={[
              "grid size-7 place-items-center rounded-md text-[15px] text-text-muted",
              "hover:bg-surface hover:text-text disabled:opacity-35",
            ].join(" ")}
          >
            ＋
          </button>
        </div>
      </div>
      <div className="px-5 pb-6 pt-16 sm:px-6">
        <div className="prose-harness" data-layout={layout} data-font={font}>
          <Markdown remarkPlugins={[remarkGfm]} components={components}>
            {content}
          </Markdown>
        </div>
      </div>
    </section>
  );
}
