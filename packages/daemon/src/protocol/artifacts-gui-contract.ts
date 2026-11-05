import { queryPageRow } from "./daemon-protocol-validate-task.ts";
import type { CursorPage } from "../task-index-query.ts";
import { isJsonObject, rejectSecretKeys } from "./json-rpc-types.ts";
import { nullableNonEmpty, utcTimestamp } from "./schedules-gui-contract.ts";

/** Artifacts GUI wire contract。每页 `repo.artifacts.list` 的 DTO 是「全部 task 包
 * artifacts/ 下的 html/md 文件」×「文档投影(台账时间)」×「task 归属(投影
 * packagePath→taskId/title 批量 join)」的只读投影;renderer 只格式化,不扫盘、
 * 不重算时间来源。本文件只持线形状与校验,读侧 join 在
 * packages/daemon/src/artifacts-gui-read.ts,protocol 目录不引 kernel barrel。 */
export type ArtifactGuiKind = "html" | "md" | "raw";

/** `ledger` = 台账 doc 事件 occurredAt;`mtime` = 文件系统 mtime(未 doc-sync 或
 * 投影缺行时的事实来源,列上必须标明)。 */
export type ArtifactTimeSource = "ledger" | "mtime";

export interface ArtifactGuiRowDto {
  /** 投影里的归属 task;包存在但投影无对应 task 时为 null(列仍显示路径)。 */
  readonly taskId: string | null;
  readonly taskTitle: string | null;
  /** 台账任务包路径(tasks/<package>),与文档投影路径同源。 */
  readonly packagePath: string | null;
  /** 任务包内相对路径(artifacts/…),可直接喂给 repo.tasks.document.read。 */
  readonly path: string;
  readonly kind: ArtifactGuiKind;
  /** 文件的媒体类型;raw 行是 application/octet-stream,html/md 是它们各自的文本类型。 */
  readonly mediaType: string;
  /** 磁盘字节数。raw 行没有正文可读,字节数与取字节的路由才是这一行的内容事实。 */
  readonly sizeBytes: number;
  /** UTC 时间戳;来源见 timeSource。 */
  readonly time: string;
  readonly timeSource: ArtifactTimeSource;
}

export interface ArtifactsListResult {
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly repoId: string;
  /** 本页返回的 facet;html 是时间线默认面,md/raw 必须显式请求(md 体量 ~77×)。 */
  readonly kind: ArtifactGuiKind;
  readonly artifacts: readonly ArtifactGuiRowDto[];
  readonly page: CursorPage;
  /** 遍历事实:三种 kind 的全量计数(与返回 facet 无关),筛选 chip 用。 */
  readonly counts: { readonly html: number; readonly md: number; readonly raw: number };
  /** 超过计数上限的 facet 为 true:counts 已封顶,GUI 角标显示 `999+`。
   *
   * 兼容窗口:上一版(v3)daemon 不返回该字段,缺省视为 false。按 dec_659E15CF 的“当前+上一版”
   * 窗口保留读取兼容;**下一版协议发布后删除**,最迟 2026-12-05 或当前 minor 前进时(以先到者为准)。 */
  readonly countsCapped?: { readonly html: boolean; readonly md: boolean; readonly raw: boolean };
  readonly watermark: number;
  readonly sourceRevision: number;
}

const artifactsListFields = [
  "ok",
  "status",
  "repoId",
  "kind",
  "artifacts",
  "page",
  "counts",
  "countsCapped",
  "watermark",
  "sourceRevision",
] as const;
const artifactRowFields = [
  "taskId",
  "taskTitle",
  "packagePath",
  "path",
  "kind",
  "mediaType",
  "sizeBytes",
  "time",
  "timeSource",
] as const;
const artifactKinds = ["html", "md", "raw"] as const;

/** 三个 facet 的全量计数,一个都不能缺:少一个键就等于让筛选面悄悄少一类产物。 */
function artifactCounts(value: unknown): boolean {
  if (!isJsonObject(value) || Object.keys(value).length !== artifactKinds.length) return false;
  return artifactKinds.every((name) => Number.isSafeInteger(value[name]) && Number(value[name]) >= 0);
}

/** 封顶标记与 counts 同形:每个 facet 都必须明确是否封顶。 */
function artifactCountFlags(value: unknown): boolean {
  if (!isJsonObject(value) || Object.keys(value).length !== artifactKinds.length) return false;
  return artifactKinds.every((name) => typeof value[name] === "boolean");
}

function artifactNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function artifactPath(value: unknown): value is string {
  return artifactNonEmptyText(value) && value.startsWith("artifacts/") && !value.endsWith("/");
}

function nullablePackagePath(value: unknown): boolean {
  return value === null || (artifactNonEmptyText(value) && value.startsWith("tasks/") && !value.includes(".."));
}

export function validateArtifactsList(value: unknown): readonly string[] {
  if (
    !isJsonObject(value) ||
    Object.keys(value).some((field) => !artifactsListFields.includes(field as (typeof artifactsListFields)[number])) ||
    value.ok !== true ||
    !["ready", "pending"].includes(String(value.status)) ||
    !artifactNonEmptyText(value.repoId) ||
    !artifactKinds.includes(String(value.kind) as (typeof artifactKinds)[number]) ||
    !Array.isArray(value.artifacts) ||
    !queryPageRow(value.page) ||
    !artifactCounts(value.counts) ||
    (value.countsCapped !== undefined && !artifactCountFlags(value.countsCapped)) ||
    !Number.isSafeInteger(value.watermark) ||
    !Number.isSafeInteger(value.sourceRevision)
  )
    return ["artifacts list is invalid"];
  const secretErrors = rejectSecretKeys(value);
  if (secretErrors.length) return secretErrors;
  for (const row of value.artifacts) {
    if (
      !isJsonObject(row) ||
      Object.keys(row).some((field) => !artifactRowFields.includes(field as (typeof artifactRowFields)[number])) ||
      !nullableNonEmpty(row.taskId) ||
      !nullableNonEmpty(row.taskTitle) ||
      !nullablePackagePath(row.packagePath) ||
      !artifactPath(row.path) ||
      !artifactKinds.includes(String(row.kind) as (typeof artifactKinds)[number]) ||
      !artifactNonEmptyText(row.mediaType) ||
      !Number.isSafeInteger(row.sizeBytes) ||
      Number(row.sizeBytes) < 0 ||
      !utcTimestamp(row.time) ||
      !["ledger", "mtime"].includes(String(row.timeSource))
    )
      return ["artifact row is invalid"];
  }
  return [];
}

export const serializeArtifactsList = (value: unknown): string => {
  const errors = validateArtifactsList(value);
  if (errors.length) throw new TypeError(errors.join("; "));
  return `${JSON.stringify(value)}\n`;
};
