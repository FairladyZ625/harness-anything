import { FileX } from "@phosphor-icons/react";
import { DocumentFrame } from "./DocumentFrame";

const IMAGE_MEDIA = /^image\/(?:png|jpeg|gif|webp|avif|svg\+xml|bmp|x-icon)$/u;

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
  if (bytes !== null && mediaType === "application/pdf")
    return (
      <DocumentFrame testId="document-pdf-preview" toolbar={<div className="px-3 py-2 ui-meta">{path}</div>}>
        <iframe
          title={path}
          src={`data:application/pdf;base64,${bytes}`}
          className="h-[var(--long-content-cap)] min-h-96 w-full border-0"
        />
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
