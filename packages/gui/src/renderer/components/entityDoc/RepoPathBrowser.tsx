import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, File, Folder, FolderOpen } from "@phosphor-icons/react";
import { repoDirectoryQuery } from "../../entity-locator-client.ts";

/**
 * 仓内路径选择器(task_a494eac2 Goal 1):不手输,浏览选定。数据全部来自既有
 * `repo.entity.locator.read` 的目录一层条目——子目录展开就是对子路径再发同一条读,
 * 不新增任何 daemon 能力。
 *
 * 起点必须是一个真实子目录(seed):读面对仓根本身(空路径/`.`)是拒绝的,所以
 * 浏览器不从「/」开始,而从调用方给的 seed 开始,向上导航到顶层目录为止。
 */
export function RepoPathBrowser({
  repoId,
  seed,
  selectedPath,
  onPickFile,
  onPickDirectory,
}: {
  readonly repoId: string;
  readonly seed: string;
  readonly selectedPath: string | null;
  readonly onPickFile: (path: string) => void;
  readonly onPickDirectory: (path: string) => void;
}) {
  const [directory, setDirectory] = useState(seed);
  const read = useQuery(repoDirectoryQuery(repoId, directory));
  const parent = parentDirectory(directory);
  const pickCurrent = () => onPickDirectory(directory);
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-surface p-2" data-testid="repo-path-browser">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="上一级目录"
          title={parent === null ? "顶层目录之上是仓根,读面列举不了仓根本身" : parent}
          disabled={parent === null}
          onClick={() => parent !== null && setDirectory(parent)}
          className={[
            "grid size-6 shrink-0 place-items-center rounded border border-border",
            parent === null ? "cursor-not-allowed text-text-faint opacity-50" : "text-text-muted hover:text-text",
          ].join(" ")}
        >
          <ArrowUp weight="bold" className="ui-micro" />
        </button>
        <code
          data-testid="repo-path-browser-location"
          title={directory}
          className="min-w-0 flex-1 truncate rounded bg-surface-raised px-2 py-1 font-mono ui-micro text-text-muted"
        >
          {directory || "(仓根)"}
        </code>
        <button
          type="button"
          data-testid="repo-path-browser-pick-directory"
          onClick={pickCurrent}
          className={[
            "inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-1",
            "ui-micro text-text-muted hover:border-border-strong hover:text-text",
          ].join(" ")}
        >
          <FolderOpen weight="bold" className="ui-micro" />
          选定当前目录
        </button>
      </div>
      <div className="max-h-64 overflow-y-auto rounded border border-border/60" data-testid="repo-path-browser-entries">
        {read.isPending ? (
          <p className="px-2 py-2 ui-micro text-text-faint">读取 {directory} …</p>
        ) : read.isError ? (
          <p data-testid="repo-path-browser-error" className="px-2 py-2 ui-micro text-status-blocked">
            读取失败:{read.error instanceof Error ? read.error.message : String(read.error)}
          </p>
        ) : read.data.outcome !== "directory" ? (
          <p className="px-2 py-2 ui-micro text-status-blocked">
            {directory} 不是可列举的目录({read.data.outcome})。
          </p>
        ) : (
          <>
            {read.data.truncated && <p className="px-2 py-1 ui-micro text-text-faint">条目过多,只列前 500 条。</p>}
            {read.data.entries.length === 0 && <p className="px-2 py-2 ui-micro text-text-faint">空目录。</p>}
            {orderedEntries(read.data.entries).map(({ path, directory: isDirectory }) =>
              isDirectory ? (
                <button
                  key={path}
                  type="button"
                  data-testid={`repo-path-entry-${path}`}
                  onClick={() => setDirectory(path)}
                  className={[
                    "flex w-full items-center gap-1.5 px-2 py-1 text-left font-mono ui-micro",
                    "text-text-muted hover:bg-surface-raised hover:text-text",
                  ].join(" ")}
                >
                  <Folder weight="bold" className="shrink-0 text-text-faint" />
                  <span className="min-w-0 truncate">{segmentName(path)}/</span>
                </button>
              ) : (
                <button
                  key={path}
                  type="button"
                  data-testid={`repo-path-entry-${path}`}
                  onClick={() => onPickFile(path)}
                  className={[
                    "flex w-full items-center gap-1.5 px-2 py-1 text-left font-mono ui-micro",
                    "text-text-muted hover:bg-surface-raised hover:text-text",
                  ].join(" ")}
                >
                  <File className="shrink-0 text-text-faint" />
                  <span className="min-w-0 truncate">{segmentName(path)}</span>
                </button>
              ),
            )}
          </>
        )}
      </div>
      {selectedPath !== null && (
        <p className="ui-micro text-text-faint">
          已选:<code className="break-all font-mono ui-micro text-text">{selectedPath}</code>
        </p>
      )}
    </div>
  );
}

/** 目录优先,同类按名字排序——与既有文件树(DocTree)同一秩序。 */
function orderedEntries(entries: readonly { readonly path: string; readonly directory: boolean }[]) {
  return [...entries].sort((left, right) => {
    if (left.directory !== right.directory) return left.directory ? -1 : 1;
    return segmentName(left.path).localeCompare(segmentName(right.path));
  });
}

function segmentName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

/** 上一级;已在顶层(单段)时为 null——仓根本身列举不了,导航到那里为止。 */
export function parentDirectory(directory: string): string | null {
  const segments = directory.split("/").filter(Boolean);
  return segments.length <= 1 ? null : segments.slice(0, -1).join("/");
}

/**
 * seed 推导:取一组 locator 路径最深公共父目录;没有可用行时返回 null(调用方降级到输入)。
 */
export function commonParentDirectory(paths: readonly string[]): string | null {
  const splits = paths
    .filter((path) => path.trim().length > 0)
    .map((path) => path.split("/").filter((segment) => segment.length > 0));
  if (splits.length === 0) return null;
  const shared: string[] = [];
  const first = splits[0]!;
  for (let index = 0; index < first.length - 1; index += 1) {
    const segment = first[index]!;
    if (splits.every((parts) => parts[index] === segment)) shared.push(segment);
    else break;
  }
  return shared.length === 0 ? null : shared.join("/");
}
