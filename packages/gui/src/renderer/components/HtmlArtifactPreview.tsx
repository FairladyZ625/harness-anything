import { useEffect, useRef } from "react";
import { buildHtmlArtifactDataUrl, HTML_ARTIFACT_PARTITION } from "../../api/html-artifact-policy.ts";

export function HtmlArtifactPreview({ content, path }: { readonly content: string; readonly path: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const preview = document.createElement("webview");
    preview.dataset.testid = "html-artifact-webview";
    preview.dataset.artifactPath = path;
    preview.setAttribute("aria-label", `HTML artifact 预览：${path}`);
    preview.setAttribute("partition", HTML_ARTIFACT_PARTITION);
    preview.setAttribute(
      "webpreferences",
      [
        "contextIsolation=yes",
        "nodeIntegration=no",
        "nodeIntegrationInWorker=no",
        "nodeIntegrationInSubFrames=no",
        "sandbox=yes",
        "javascript=no",
        "webSecurity=yes",
        "plugins=no",
        "webviewTag=no",
      ].join(","),
    );
    preview.setAttribute("src", buildHtmlArtifactDataUrl(content));
    preview.className = "html-artifact-webview";
    host.replaceChildren(preview);
    return () => preview.remove();
  }, [content, path]);

  return (
    <section className="overflow-hidden rounded-lg border border-border bg-surface" data-testid="html-artifact-preview">
      <header className="flex items-center justify-between gap-3 border-b border-border bg-surface-raised px-3 py-2">
        <span className="min-w-0 truncate font-mono text-[11px] text-text-muted">{path}</span>
        <span className="shrink-0 font-mono text-[10px] text-text-faint">
          隔离本地预览 · 脚本 / 外联已禁用
        </span>
      </header>
      <div ref={hostRef} className="min-h-[42rem] bg-white" />
    </section>
  );
}
