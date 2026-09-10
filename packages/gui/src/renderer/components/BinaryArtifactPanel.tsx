import { useCallback, useState } from "react";
import { ArrowSquareOut, FileX } from "@phosphor-icons/react";
import type { TaskDocumentProjectionRead } from "../../api/renderer-dto.ts";
import { openArtifactExternally } from "../artifact-open-client.ts";

/** 二进制任务产物的读侧面板:元数据 + 取字节的真实路径 + 交给系统查看器打开。
 * 不在渲染进程里把字节转成字符串,也不假装它是一份空文档。 */
export function BinaryArtifactPanel({
  repoId,
  taskId,
  path,
  packagePath,
  read,
}: {
  readonly repoId: string;
  readonly taskId: string;
  readonly path: string;
  readonly packagePath: string | null;
  readonly read: TaskDocumentProjectionRead;
}) {
  const [openError, setOpenError] = useState<string | null>(null);
  const artifactPath = packagePath === null ? null : `${packagePath}/${path}`;
  const openExternally = useCallback(async () => {
    if (artifactPath === null) return;
    setOpenError(null);
    const outcome = await openArtifactExternally({ repoId, path: artifactPath, taskId });
    if (outcome.error !== null) setOpenError(outcome.error);
  }, [artifactPath, repoId, taskId]);
  return (
    <div data-testid="task-document-binary" className="border border-border-strong">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-raised px-3 py-2">
        <FileX weight="duotone" className="text-base text-text-faint" />
        <span className="ui-meta text-text">二进制产物,不是文本</span>
        <span className="grow" />
        <button
          type="button"
          data-testid="task-document-binary-open"
          onClick={openExternally}
          disabled={artifactPath === null}
          title={artifactPath === null ? "任务包路径未知,无法定位产物文件。" : "在系统查看器中打开原始字节"}
          className={[
            "flex items-center gap-1 border border-border px-2 py-1 font-mono ui-micro",
            "text-text-muted hover:text-text disabled:opacity-50",
          ].join(" ")}
        >
          <ArrowSquareOut className="size-3" />
          打开
        </button>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 px-3 py-3 font-mono ui-micro">
        <BinaryFact label="媒体类型" value={read.mediaType ?? "未知"} />
        <BinaryFact label="字节数" value={read.size === null ? "未知" : `${read.size}`} />
        <BinaryFact label="内容地址" value={read.blobSha256 ?? "尚未入账"} />
        <BinaryFact label="仓库路径" value={read.repositoryPath} />
      </dl>
      {read.bytes === null ? (
        <p className="border-t border-border px-3 py-2 ui-micro leading-5 text-text-faint">
          字节未随本次读取返回(尚未入账,或超过内联上限);按上面的仓库路径读取原始文件。
        </p>
      ) : null}
      {openError !== null ? (
        <p className="border-t border-border px-3 py-2 ui-micro leading-5 text-danger">{openError}</p>
      ) : null}
    </div>
  );
}

function BinaryFact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <>
      <dt className="text-text-faint">{label}</dt>
      <dd className="min-w-0 break-all text-text-muted">{value}</dd>
    </>
  );
}
