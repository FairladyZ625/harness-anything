/**
 * 实体 locator → 渲染器的**唯一**选择表(task_0df76ed3fb 设计页 §2)。
 *
 * locator 是一个指针,指向的东西是文件还是目录**由读面说了算**,不由路径长相说了算:
 * 这张表因此收两个输入——指针本身与 `repo.entity.locator.read` 回来的 outcome。以前
 * 靠「末段有没有点」猜目录,把 `v1.2/` 这样的目录判成渲染不了、把没有扩展名的文件
 * 判成目录树;那次猜测已经删掉。
 *
 * 表里只出现仓里已经有的渲染实现,认不出来的一律 `opaque`——显示元数据卡,不假装能渲染。
 */
export type EntityLocatorRenderer = "markdown" | "html" | "pdf" | "directory" | "opaque";

/** 读面对一个 locator 的判定,与 `entity-locator-read/v1` 的 outcome 同词表。 */
export type EntityLocatorReadOutcome = "file" | "directory" | "missing" | "unsupported" | "too-large" | "binary";

export interface EntityLocator {
  /** kernel artifactLocatorKinds: repository-path / url / external-key。 */
  readonly kind: string;
  readonly value: string;
}

/** HTML 产物预览(#2183)的判据。渲染器选择表与产物页共用这一处。 */
export function isHtmlDocument(path: string): boolean {
  return /\.html?$/iu.test(path);
}

export function isMarkdownDocument(path: string): boolean {
  return /\.(?:md|markdown)$/iu.test(path);
}

/**
 * PDF 有独立路由:它不是「渲染不了」,而是「读面给不了字节」——读面对二进制文件返回
 * `binary` 且不载正文,GUI 因此有一张专门的事实卡(说明缺口在哪),不与 zip/图片那类
 * 真正的 opaque 指针混同。
 */
export function isPdfDocument(path: string): boolean {
  return /\.pdf$/iu.test(path);
}

export function selectEntityLocatorRenderer(
  locator: EntityLocator,
  outcome: EntityLocatorReadOutcome,
): EntityLocatorRenderer {
  if (locator.kind !== "repository-path") return "opaque";
  if (outcome === "directory") return "directory";
  if (outcome === "binary") return isPdfDocument(locator.value) ? "pdf" : "opaque";
  if (outcome !== "file") return "opaque";
  if (isHtmlDocument(locator.value)) return "html";
  if (isMarkdownDocument(locator.value)) return "markdown";
  return "opaque";
}
