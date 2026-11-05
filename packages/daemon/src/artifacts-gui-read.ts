import { markDaemonOperationPhase } from "./daemon-operation.ts";
import { consumeKnownError, mediaTypeForBinaryPath, RAW_ARTIFACT_MEDIA_TYPE } from "@harness-anything/kernel";
import type { ArtifactTimelineCursor, ArtifactTimelineKind, TaskProjection } from "@harness-anything/kernel";
import type { CursorPage } from "./task-index-query.ts";
import type { ArtifactGuiKind, ArtifactGuiRowDto, ArtifactsListResult } from "./protocol/artifacts-gui-contract.ts";

/** The GUI timeline needs exactly one projection read: the ordered artifact index page. Tests can
 * inject the narrow port without a filesystem or a full projection. */
export interface ArtifactsProjectionReads {
  readonly readArtifactTimelinePage: TaskProjection["readArtifactTimelinePage"];
}

/** Artifacts GUI 读侧:任务包 `artifacts/` 下的 html/md/raw 由投影的 artifact timeline 索引
 * 按台账时间倒序分页。旧实现先遍历全部 task 包的 `artifacts/` 子树再内存切片，页代价随
 * 历史产出线性增长（G38 3405→34005）；现在一页只读索引的一段区间，counts 是维护好的
 * 全量计数而不是对匹配集重扫。只有已 doc-sync 的产物进入时间线——文件系统里从未入账的
 * 草稿不是台账产出。 */
export interface ArtifactsGuiReadContext {
  readonly projection: ArtifactsProjectionReads;
  readonly input: { readonly repoId: string };
}

const artifactKinds: readonly ArtifactGuiKind[] = ["html", "md", "raw"];
const defaultArtifactLimit = 100,
  maximumArtifactLimit = 500;

const invalidCursor = (): Error =>
  Object.assign(new Error("Artifact list cursor is invalid; restart the query."), { code: "invalid_command" });

/** Same opaque keyset shape the previous implementation emitted: [time, relative, packageDir]. */
function decodeArtifactCursor(value: string): ArtifactTimelineCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === 3 && parsed.every((part) => typeof part === "string" && part)) {
      const [occurredAt, relative, packageDir] = parsed as [string, string, string];
      if (Number.isFinite(Date.parse(occurredAt))) return { occurredAt, relative, packageDir };
    }
  } catch (error) {
    consumeKnownError(error);
  }
  throw invalidCursor();
}

const encodeArtifactCursor = (row: {
  readonly occurredAt: string;
  readonly relative: string;
  readonly packageDir: string;
}): string => Buffer.from(JSON.stringify([row.occurredAt, row.relative, row.packageDir]), "utf8").toString("base64url");

/** Timeline media type: text facets keep their declared type, raw names claim their MIME. */
function artifactMediaType(row: { readonly kind: ArtifactTimelineKind; readonly relative: string }): string {
  if (row.kind === "html") return "text/html";
  if (row.kind === "md") return "text/markdown";
  return mediaTypeForBinaryPath(row.relative, RAW_ARTIFACT_MEDIA_TYPE)!;
}

export function readArtifactsGui(
  context: ArtifactsGuiReadContext,
  payload: Readonly<Record<string, unknown>> = {},
): ArtifactsListResult {
  markDaemonOperationPhase("artifacts.scan");
  const kind: ArtifactGuiKind = artifactKinds.includes(payload.kind as ArtifactGuiKind)
      ? (payload.kind as ArtifactGuiKind)
      : "html",
    requested = typeof payload.limit === "number" ? payload.limit : defaultArtifactLimit,
    limit = Number.isSafeInteger(requested)
      ? Math.min(Math.max(requested, 1), maximumArtifactLimit)
      : defaultArtifactLimit,
    cursor = typeof payload.cursor === "string" ? payload.cursor : undefined,
    read = context.projection.readArtifactTimelinePage({
      kind,
      limit,
      ...(cursor === undefined ? {} : { after: decodeArtifactCursor(cursor) }),
    }),
    last = read.rows.at(-1);
  return {
    ok: true,
    status: read.status,
    repoId: context.input.repoId,
    kind,
    artifacts: read.rows.map(
      (row): ArtifactGuiRowDto => ({
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        packagePath: row.packagePath,
        path: row.relative,
        kind: row.kind,
        mediaType: artifactMediaType(row),
        sizeBytes: row.sizeBytes,
        time: row.occurredAt,
        timeSource: "ledger",
      }),
    ),
    page: {
      limit,
      cursor: cursor ?? null,
      nextCursor: read.hasMore && last ? encodeArtifactCursor(last) : null,
    } satisfies CursorPage,
    counts: read.counts,
    countsCapped: read.countsCapped,
    watermark: read.watermark,
    sourceRevision: read.sourceRevision,
  };
}
