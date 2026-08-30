import { isJsonObject, rejectSecretKeys } from "./json-rpc-types.ts";

/** Artifacts GUI wire contract。一次 `repo.artifacts.list` 的 DTO 是「全部 task 包
 * artifacts/ 下的 html/md 文件」×「文档投影(台账时间)」×「task 归属(投影
 * packagePath→taskId/title 批量 join)」的只读投影;renderer 只格式化,不扫盘、
 * 不重算时间来源。本文件只持线形状与校验,读侧 join 在
 * packages/daemon/src/artifacts-gui-read.ts,protocol 目录不引 kernel barrel。 */
export type ArtifactGuiKind = "html" | "md";

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
  /** UTC 时间戳;来源见 timeSource。 */
  readonly time: string;
  readonly timeSource: ArtifactTimeSource;
}

export interface ArtifactsListResult {
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly repoId: string;
  /** 本页返回的 facet;html 是时间线默认面,md 必须显式请求(体量 ~77×)。 */
  readonly kind: ArtifactGuiKind;
  readonly artifacts: readonly ArtifactGuiRowDto[];
  /** 遍历事实:两种 kind 的全量计数(与返回 facet 无关),筛选 chip 用。 */
  readonly counts: { readonly html: number; readonly md: number };
  readonly watermark: number;
  readonly sourceRevision: number;
}

const artifactsListFields = [
  "ok",
  "status",
  "repoId",
  "kind",
  "artifacts",
  "counts",
  "watermark",
  "sourceRevision",
] as const;
const artifactRowFields = ["taskId", "taskTitle", "packagePath", "path", "kind", "time", "timeSource"] as const;

function artifactNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nullableNonEmpty(value: unknown): boolean {
  return value === null || artifactNonEmptyText(value);
}

function utcTimestamp(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value);
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
    !["html", "md"].includes(String(value.kind)) ||
    !Array.isArray(value.artifacts) ||
    !isJsonObject(value.counts) ||
    Object.keys(value.counts).length !== 2 ||
    !Number.isSafeInteger(value.counts.html) ||
    Number(value.counts.html) < 0 ||
    !Number.isSafeInteger(value.counts.md) ||
    Number(value.counts.md) < 0 ||
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
      !["html", "md"].includes(String(row.kind)) ||
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
