import { useEffect, useRef } from "react";
import { buildHtmlArtifactDataUrl, HTML_ARTIFACT_PARTITION } from "../../api/html-artifact-policy.ts";

const ISOLATION_BADGE = "隔离本地预览 · 脚本 / 外联已禁用";

export function HtmlArtifactPreview({
  content,
  path,
  fillAvailable = false,
}: {
  readonly content: string;
  readonly path: string;
  readonly fillAvailable?: boolean;
}) {
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
    <section
      className={[
        "overflow-hidden rounded-lg border border-border bg-surface",
        fillAvailable ? "html-artifact-preview-fill flex h-full min-h-0 min-w-0 flex-col" : "",
      ].join(" ")}
      data-testid="html-artifact-preview"
    >
      <header
        className={[
          "flex shrink-0 items-center justify-between gap-3",
          "border-b border-border bg-surface-raised px-3 py-2",
        ].join(" ")}
      >
        <span className="min-w-0 truncate font-mono text-[11px] text-text-muted">{path}</span>
        <span className="shrink-0 font-mono text-[10px] text-text-faint">{ISOLATION_BADGE}</span>
      </header>
      <div
        ref={hostRef}
        className={fillAvailable ? "min-h-0 min-w-0 flex-1 overflow-hidden bg-white" : "min-h-[42rem] bg-white"}
        data-testid="html-artifact-host"
      />
    </section>
  );
}
