import { readdirSync, statSync, lstatSync } from "node:fs";
import path from "node:path";
import { consumeKnownError, normalizeRelativeDocumentPath, resolveHarnessLayout } from "../../kernel/src/index.ts";
import type { ArtifactGuiKind, ArtifactGuiRowDto, ArtifactsListResult } from "./protocol/artifacts-gui-contract.ts";

/** 本读需要的投影面(结构性窄口,真实 TaskProjection 天然满足;测试可注入 stub)。 */
export interface ArtifactsProjectionReads {
  readonly readTaskStatuses: () => {
    readonly status: "ready" | "pending";
    readonly rows: readonly { readonly taskId: string }[];
    readonly watermark: number;
    readonly sourceRevision: number;
  };
  readonly readTaskRuntimeBatch: (query: { readonly taskIds: readonly string[] }) => {
    readonly rows: readonly {
      readonly taskId: string;
      readonly title: string | null;
      readonly packagePath: string | null;
    }[];
  };
  readonly readDocument: (path: string) => {
    readonly document: { readonly workspaceRevision: number } | null;
  };
  readonly readCanonicalEvents: (
    afterRevision: number,
    limit: number,
  ) => {
    readonly events: readonly { readonly workspaceRevision: number; readonly occurredAt: string }[];
  };
}

/** Artifacts GUI 读侧 join:跨全部 task 包扫 `artifacts/` 下的 html/md,按时间倒序
 * 返回。归属(taskId/title)走投影批量 join(readTaskStatuses + readTaskRuntimeBatch,
 * ≤500/批);时间优先取台账 doc 事件 occurredAt(文档投影 workspaceRevision 定位事件),
 * 投影缺行回落文件 mtime 并在 DTO 标 timeSource。纯只读:不写台账、不改任何文件。 */
export interface ArtifactsGuiReadContext {
  readonly rootDir: string;
  readonly projection: ArtifactsProjectionReads;
  readonly input: { readonly repoId: string };
}

const artifactExtensions: ReadonlyMap<string, ArtifactGuiKind> = new Map([
  [".html", "html"],
  [".htm", "html"],
  [".md", "md"],
]);
/** 防御病理树:遍历规模上限,超限部分静默截断(列表是投影,不是审计)。 */
const artifactWalkMaxFiles = 20_000;
const artifactWalkMaxVisits = 80_000;

interface ArtifactFileRow {
  readonly packageDir: string;
  readonly relative: string;
  readonly kind: ArtifactGuiKind;
  readonly mtimeMs: number;
}

function statFileSync(target: string): import("node:fs").Stats | null {
  try {
    return statSync(target);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

function statLinkSync(target: string): import("node:fs").Stats | null {
  try {
    return lstatSync(target);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

/** 一棵 artifacts/ 子树下的 html/md 文件;符号链接一律不跟(产物只认真实文件)。 */
function walkArtifactTree(artifactsRoot: string, packageDir: string): readonly ArtifactFileRow[] {
  const rows: ArtifactFileRow[] = [];
  if (statLinkSync(artifactsRoot)?.isSymbolicLink() === true || statFileSync(artifactsRoot)?.isDirectory() !== true)
    return rows;
  const queue: (readonly [string, string])[] = [[artifactsRoot, "artifacts"]];
  let visited = 0;
  while (queue.length > 0 && rows.length < artifactWalkMaxFiles && visited < artifactWalkMaxVisits) {
    const [directory, prefix] = queue.shift()!;
    let entries: readonly import("node:fs").Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      consumeKnownError(error);
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (entry.name.startsWith(".")) continue;
      const target = path.join(directory, entry.name),
        relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        queue.push([target, relative]);
        continue;
      }
      const kind = artifactExtensions.get(path.extname(entry.name).toLowerCase());
      if (kind === undefined || !entry.isFile() || statLinkSync(target)?.isSymbolicLink() === true) continue;
      const stat = statFileSync(target);
      if (stat === null || !stat.isFile()) continue;
      rows.push({ packageDir, relative, kind, mtimeMs: stat.mtimeMs });
    }
  }
  return rows;
}

/** 全部 task 包的 artifacts 文件:只进各包的 artifacts/ 子树,包内其它目录不扫,
 * 因此非 artifacts/ 的 html 永远不会出现在时间线里。 */
function walkAllTaskArtifacts(tasksRoot: string): readonly ArtifactFileRow[] {
  let entries: readonly import("node:fs").Dirent[];
  try {
    entries = readdirSync(tasksRoot, { withFileTypes: true });
  } catch (error) {
    consumeKnownError(error);
    return [];
  }
  const rows: ArtifactFileRow[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    rows.push(...walkArtifactTree(path.join(tasksRoot, entry.name, "artifacts"), entry.name));
    if (rows.length >= artifactWalkMaxFiles) break;
  }
  return rows;
}

/** 投影批量 join:packagePath → {taskId, title}。标题列取自 readTaskRuntimeBatch 的
 * snapshot json_extract 批量查询;per-task projection.read 走 entity_projection 执行态
 * 查询(实测 ~2ms/个,千包级 >2s),不用于此读。 */
function taskIndexByPackage(
  projection: ArtifactsProjectionReads,
  taskIds: readonly string[],
): ReadonlyMap<string, { taskId: string; title: string | null }> {
  const result = new Map<string, { taskId: string; title: string | null }>();
  const ordered = [...taskIds].sort();
  for (let offset = 0; offset < ordered.length; offset += 500) {
    for (const row of projection.readTaskRuntimeBatch({ taskIds: ordered.slice(offset, offset + 500) }).rows)
      if (row.packagePath !== null) result.set(row.packagePath, { taskId: row.taskId, title: row.title });
  }
  return result;
}

/** 文档投影行 → 台账事件时间(workspaceRevision 定位事件,occurredAt 按 revision 记忆:
 * 一次 doc-sync 事件落多文件时只查一次)。投影缺行/事件不在该 revision 时返回 null。 */
function ledgerTimeOf(
  projection: ArtifactsProjectionReads,
  documentKey: string,
  eventTimes: Map<number, string>,
): string | null {
  const document = projection.readDocument(documentKey).document;
  if (document === null) return null;
  const cached = eventTimes.get(document.workspaceRevision);
  if (cached !== undefined) return cached;
  const [event] = projection.readCanonicalEvents(document.workspaceRevision - 1, 1).events,
    time = event !== undefined && event.workspaceRevision === document.workspaceRevision ? event.occurredAt : null;
  if (time !== null) eventTimes.set(document.workspaceRevision, time);
  return time;
}

export function readArtifactsGui(
  context: ArtifactsGuiReadContext,
  payload: Readonly<Record<string, unknown>> = {},
): ArtifactsListResult {
  const kind: ArtifactGuiKind = payload.kind === "md" ? "md" : "html",
    cut = context.projection.readTaskStatuses(),
    files = walkAllTaskArtifacts(resolveHarnessLayout(context.rootDir).tasksRoot),
    counts = {
      html: files.filter((row) => row.kind === "html").length,
      md: files.filter((row) => row.kind === "md").length,
    },
    tasksByPackage = taskIndexByPackage(
      context.projection,
      cut.rows.map(({ taskId }) => taskId),
    ),
    eventTimes = new Map<number, string>(),
    artifacts: readonly ArtifactGuiRowDto[] = files
      .filter((row) => row.kind === kind)
      .map((row) => {
        const packagePath = `tasks/${row.packageDir}`,
          task = tasksByPackage.get(packagePath) ?? null,
          time = ledgerTimeOf(
            context.projection,
            normalizeRelativeDocumentPath(`${packagePath}/${row.relative}`),
            eventTimes,
          );
        return {
          taskId: task?.taskId ?? null,
          taskTitle: task?.title ?? null,
          packagePath: task === null ? null : packagePath,
          path: row.relative,
          kind: row.kind,
          time: time ?? new Date(row.mtimeMs).toISOString(),
          timeSource: time === null ? ("mtime" as const) : ("ledger" as const),
        };
      })
      .sort((left, right) => right.time.localeCompare(left.time) || left.path.localeCompare(right.path));
  return {
    ok: true,
    status: cut.status,
    repoId: context.input.repoId,
    kind,
    artifacts,
    counts,
    watermark: cut.watermark,
    sourceRevision: cut.sourceRevision,
  };
}
