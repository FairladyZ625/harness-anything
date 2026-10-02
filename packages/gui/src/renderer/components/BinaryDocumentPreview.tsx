import { useEffect, useRef, useState } from "react";
import { FileX } from "@phosphor-icons/react";
import { DocumentFrame } from "./DocumentFrame";

const IMAGE_MEDIA = /^image\/(?:png|jpeg|gif|webp|avif|svg\+xml|bmp|x-icon)$/u;
const DOCX_MEDIA = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Inline preview for bytes already authorized by the caller. */
export function BinaryDocumentPreview({
  path,
  mediaType,
  bytes,
  previewText = null,
  message = "此格式已读取，但当前查看器不提供页式预览。",
}: {
  readonly path: string;
  readonly mediaType: string | null;
  readonly bytes: string | null;
  readonly previewText?: string | null;
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
  if (mediaType === "application/msword" && previewText !== null)
    return (
      <DocumentFrame
        testId="document-doc-text-preview"
        toolbar={<div className="px-3 py-2 ui-meta">{path} · DOC 文本预览</div>}
      >
        <pre className="whitespace-pre-wrap break-words p-5 font-mono ui-meta leading-6 text-text">{previewText}</pre>
      </DocumentFrame>
    );
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

function PdfDocumentPreview({ path, bytes }: { readonly path: string; readonly bytes: string }) {
  const [error, setError] = useState<string | null>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    const render = async () => {
      const data = Uint8Array.from(atob(bytes), (character) => character.charCodeAt(0));
      const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist");
      GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      const pdf = await getDocument({ data }).promise;
      if (canvasHost.current === null) return;
      canvasHost.current.replaceChildren();
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1.35 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.className = "mx-auto mb-4 block max-w-full bg-white shadow";
        canvasHost.current.append(canvas);
        await page.render({ canvas, viewport }).promise;
        if (cancelled) return;
      }
    };
    void render().catch((cause) => {
      console.error("PDF rendering failed:", cause);
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
    };
  }, [bytes]);
  return (
    <DocumentFrame testId="document-pdf-preview" toolbar={<div className="px-3 py-2 ui-meta">{path} · PDF</div>}>
      {error === null ? (
        <div ref={canvasHost} className="min-h-40 bg-surface-raised p-4" data-pdf-pages />
      ) : (
        <PreviewFailure message={error} />
      )}
    </DocumentFrame>
  );
}

function DocxDocumentPreview({ path, bytes }: { readonly path: string; readonly bytes: string }) {
  const body = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const render = async () => {
      const data = Uint8Array.from(atob(bytes), (character) => character.charCodeAt(0));
      if (body.current === null) return;
      const { renderAsync } = await import("docx-preview");
      await renderAsync(data, body.current, undefined, {
        breakPages: true,
        inWrapper: true,
        renderHeaders: true,
        renderFooters: true,
        renderFootnotes: true,
        renderEndnotes: true,
      });
    };
    void render().catch((cause) => {
      console.error("DOCX rendering failed:", cause);
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      cancelled = true;
    };
  }, [bytes]);
  return (
    <DocumentFrame testId="document-docx-preview" toolbar={<div className="px-3 py-2 ui-meta">{path} · DOCX</div>}>
      {error === null ? (
        <div ref={body} className="docx-preview-host min-w-0 p-4" />
      ) : (
        <PreviewFailure message={error} />
      )}
    </DocumentFrame>
  );
}

function PreviewFailure({ message }: { readonly message: string }) {
  return (
    <div role="alert" className="p-6 ui-meta text-danger">
      无法渲染文件：{message}。仍可使用系统查看器打开原始文件。
    </div>
  );
}
