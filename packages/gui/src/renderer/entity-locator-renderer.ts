/**
 * 实体 locator → 渲染器的**唯一**选择表(task_0df76ed3fb 设计页 §2)。
 *
 * 实体的正文不住在账本里,locator 只是一个指针。哪个指针用哪个既有渲染器,
 * 在这里判一次;GUI 别处不得再按扩展名分支。表里只出现仓里已经有的三种渲染
 * 实现,认不出来的一律 `opaque`——显示元数据卡 + 「在系统中打开」,不假装能渲染。
 */
export type EntityLocatorRenderer = "markdown" | "html" | "directory" | "opaque";

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

/** 末段不含点、或以 / 结尾 → 目录指针(harness 下的 research 目录一类)。 */
export function isDirectoryLocator(path: string): boolean {
  if (path.endsWith("/")) return true;
  const last = path.split("/").filter(Boolean).at(-1);
  return last !== undefined && !last.includes(".");
}

export function selectEntityLocatorRenderer(locator: EntityLocator): EntityLocatorRenderer {
  if (locator.kind !== "repository-path") return "opaque";
  if (isDirectoryLocator(locator.value)) return "directory";
  if (isHtmlDocument(locator.value)) return "html";
  if (isMarkdownDocument(locator.value)) return "markdown";
  return "opaque";
}
