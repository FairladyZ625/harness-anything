import { Code, Globe } from "@phosphor-icons/react";
import { useState } from "react";
import type { FdeHtmlPreviews } from "../../studio/studio-api.ts";

interface HtmlSandboxPaneProps {
  readonly previews: FdeHtmlPreviews | null;
}

export function HtmlSandboxPane({ previews }: HtmlSandboxPaneProps) {
  const [target, setTarget] = useState<"project-atlas" | "explainer">("project-atlas");
  const [showSource, setShowSource] = useState(false);

  const html = target === "project-atlas" ? (previews?.projectAtlasHtml ?? "") : (previews?.explainerHtml ?? "");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-pressed={target === "project-atlas"}
            onClick={() => setTarget("project-atlas")}
            className={`inline-flex h-7 items-center gap-1 rounded border px-2.5 font-mono text-[11px] ${
              target === "project-atlas"
                ? "border-[var(--color-accent)] bg-[color-mix(in_oklch,var(--color-accent)_16%,transparent)] text-[var(--color-accent)]"
                : "border-[var(--color-border)] text-[var(--color-text-muted)]"
            }`}
          >
            <Globe size={13} /> project-atlas.html
          </button>
          <button
            type="button"
            aria-pressed={target === "explainer"}
            onClick={() => setTarget("explainer")}
            className={`inline-flex h-7 items-center gap-1 rounded border px-2.5 font-mono text-[11px] ${
              target === "explainer"
                ? "border-[var(--color-accent)] bg-[color-mix(in_oklch,var(--color-accent)_16%,transparent)] text-[var(--color-accent)]"
                : "border-[var(--color-border)] text-[var(--color-text-muted)]"
            }`}
          >
            <Globe size={13} /> explainer.html
          </button>
        </div>

        <button
          type="button"
          aria-pressed={showSource}
          onClick={() => setShowSource((prev) => !prev)}
          className="inline-flex h-7 items-center gap-1 rounded border border-[var(--color-border)] px-2.5 text-[11px] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]"
        >
          <Code size={13} /> {showSource ? "Sandbox" : "HTML"}
        </button>
      </div>

      {showSource ? (
        <pre className="m-0 flex-1 overflow-auto bg-[var(--color-bg)] p-3 font-mono text-[11px] leading-relaxed">
          {html}
        </pre>
      ) : (
        <iframe
          title={target === "project-atlas" ? "project-atlas.html sandbox preview" : "explainer.html sandbox preview"}
          sandbox=""
          srcDoc={html}
          className="h-full w-full flex-1 border-0 bg-white"
        />
      )}
    </div>
  );
}
