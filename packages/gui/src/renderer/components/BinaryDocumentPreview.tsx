import { useEffect, useRef, useState } from "react";
import { FileX } from "@phosphor-icons/react";
import type { PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist";
import { extractWordPreview } from "../local-doc/local-doc-client.ts";
import { DocumentFrame, PreviewFailure } from "./DocumentFrame";
import { SpreadsheetPreview, spreadsheetFormatLabel } from "./SpreadsheetPreview.tsx";
import { guiHostBridge } from "../gui-transport.ts";

const PPTX_MEDIA = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const IMAGE_MEDIA = /^image\/(?:png|jpeg|gif|webp|avif|svg\+xml|bmp|x-icon)$/u;
const DOCX_MEDIA = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Inline preview for bytes already authorized by the caller. */
export function BinaryDocumentPreview({
  path,
  mediaType,
  bytes,
  message = "此格式已读取，但当前查看器不提供页式预览。",
}: {
  readonly path: string;
  readonly mediaType: string | null;
  readonly bytes: string | null;
  readonly message?: string;
}) {
  const image = bytes !== null && IMAGE_MEDIA.test(mediaType ?? "");
  if (image)
    return (
      <DocumentFrame testId="document-binary-image" toolbar={<div className="px-3 py-2 ui-meta">{path}</div>}>
        <img src={`data:${mediaType};base64,${bytes}`} alt={path} className="mx-auto block h-auto max-w-full" />
      </DocumentFrame>
    );
  if (bytes !== null && mediaType === "application/pdf") return <PdfDocumentPreview path={path} bytes={bytes} />;
  if (bytes !== null && mediaType === DOCX_MEDIA) return <DocxDocumentPreview path={path} bytes={bytes} />;
  if (bytes !== null && mediaType === PPTX_MEDIA) return <PptxDocumentPreview path={path} bytes={bytes} />;
  if (mediaType === "application/msword" && bytes !== null)
    return <LegacyWordPreview key={bytes} path={path} bytes={bytes} />;
  if (bytes !== null && spreadsheetFormatLabel(mediaType) !== null)
    return <SpreadsheetPreview path={path} mediaType={mediaType!} bytes={bytes} />;
  return (
    <DocumentFrame
      testId="document-binary-preview"
      toolbar={
        <div className="flex items-center gap-2 px-3 py-2 ui-meta">
          <FileX weight="duotone" className="text-text-faint" />
          <span>{path}</span>
          <span className="text-text-faint">{mediaType ?? "未知类型"}</span>
        </div>
      }
    >
      <div className="grid min-h-32 place-items-center gap-2 p-6 text-center ui-meta text-text-muted">
        <p>{message}</p>
        <p className="font-mono ui-micro text-text-faint">
          {bytes === null ? "字节未随本次读取返回" : "可用系统查看器打开原始文件"}
        </p>
      </div>
    </DocumentFrame>
  );
}

function PptxDocumentPreview({ path, bytes }: { readonly path: string; readonly bytes: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const target = host.current;
    target?.replaceChildren();
    setError(null);
    const render = async () => {
      const preview = await guiHostBridge()?.localDoc?.pptx({ bytes });
      if (!preview) throw new Error("PPTX preview IPC is unavailable.");
      const { renderSlide } = await import("@silurus/ooxml/pptx");
      if (target === null || cancelled) return;
      for (const slide of preview.slides) {
        if (cancelled) return;
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(preview.slideWidth);
        canvas.height = Math.ceil(preview.slideHeight);
        canvas.className = "mx-auto mb-4 block max-w-full bg-white shadow";
        target.append(canvas);
        await renderSlide(canvas, slide as never, preview.slideWidth, preview.slideHeight);
      }
    };
    void render().catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
      target?.replaceChildren();
    };
  }, [bytes]);
  return (
    <DocumentFrame testId="document-pptx-preview" toolbar={<div className="px-3 py-2 ui-meta">{path} · PPTX</div>}>
      <div
        ref={host}
        hidden={error !== null}
        className="min-h-40 bg-surface-raised overflow-auto p-4"
        data-pptx-slides
      />
      {error !== null && <PreviewFailure message={error} />}
    </DocumentFrame>
  );
}

function PdfDocumentPreview({ path, bytes }: { readonly path: string; readonly bytes: string }) {
  const [error, setError] = useState<string | null>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    let renderTask: RenderTask | undefined;
    const host = canvasHost.current;
    host?.replaceChildren();
    setError(null);
    const render = async () => {
      const data = Uint8Array.from(atob(bytes), (character) => character.charCodeAt(0));
      const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist");
      if (cancelled || host === null) return;
      GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      loadingTask = getDocument({ data });
      const pdf = await loadingTask.promise;
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        if (cancelled) return;
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: 1.35 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.className = "mx-auto mb-4 block max-w-full bg-white shadow";
        host.append(canvas);
        renderTask = page.render({ canvas, viewport });
        await renderTask.promise;
        if (cancelled) return;
      }
    };
    void render().catch((cause) => {
      if (cancelled) return;
      console.error("PDF rendering failed:", cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
      void loadingTask?.destroy().catch((cause) => console.error("PDF cleanup failed:", cause));
    };
  }, [bytes]);
  return (
    <DocumentFrame testId="document-pdf-preview" toolbar={<div className="px-3 py-2 ui-meta">{path} · PDF</div>}>
      <div ref={canvasHost} hidden={error !== null} className="min-h-40 bg-surface-raised p-4" data-pdf-pages />
      {error !== null && <PreviewFailure message={error} />}
    </DocumentFrame>
  );
}

function DocxDocumentPreview({ path, bytes }: { readonly path: string; readonly bytes: string }) {
  const body = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const host = body.current;
    host?.replaceChildren();
    setError(null);
    const render = async () => {
      const data = Uint8Array.from(atob(bytes), (character) => character.charCodeAt(0));
      if (host === null) return;
      const { renderAsync } = await import("docx-preview");
      if (cancelled) return;
      const rendered = document.createElement("div");
      await renderAsync(data, rendered, undefined, {
        useBase64URL: true,
        breakPages: true,
        inWrapper: true,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
      });
      if (!cancelled) host.replaceChildren(...rendered.childNodes);
    };
    void render().catch((cause) => {
      if (cancelled) return;
      console.error("DOCX rendering failed:", cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
    };
  }, [bytes]);
  return (
    <DocumentFrame testId="document-docx-preview" toolbar={<div className="px-3 py-2 ui-meta">{path} · DOCX</div>}>
      <div ref={body} hidden={error !== null} className="docx-preview-host min-w-0 p-4 text-black" />
      {error !== null && <PreviewFailure message={error} />}
    </DocumentFrame>
  );
}

function LegacyWordPreview({ path, bytes }: { readonly path: string; readonly bytes: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void extractWordPreview(bytes).then(
      (value) => {
        if (active) setText(value);
      },
      (cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [bytes]);
  return (
    <DocumentFrame
      testId="document-doc-text-preview"
      toolbar={<div className="px-3 py-2 ui-meta">{path} · DOC 文本预览</div>}
    >
      {error !== null ? (
        <p role="alert" className="p-4 text-danger">
          {error}
        </p>
      ) : text === null ? (
        <p className="p-4">正在读取文档…</p>
      ) : (
        <pre className="whitespace-pre-wrap break-words p-5 font-mono ui-meta leading-6 text-text">{text}</pre>
      )}
    </DocumentFrame>
  );
}
