/**
 * 新建实体的预览推导(task_a494eac2 Goal 1)。
 *
 * 理想路径是 `entity import --dry-run` 的 preview,但 GUI 的 `repo.entity.import`
 * facet payload 是闭集(entityKind/locator/expectedVersion/title),dryRun 发不过去
 * ——daemon 执行器本身支持 dryRun,缺的只是 GUI 通道那一格。在通道补上之前,这里按
 * **同一条公式**在渲染层推导预览:id = `idPrefix-sha256("repo:<repoId>:<path>")[0:16]`
 * (kernel `deriveArtifactEntityId` + `canonicalSourceIdentity`),title = 目录 README.md
 * 首标题 / 文件首行 `# 标题` / 文件名(daemon `resolveArtifactSource` + `titleFromContent`)。
 *
 * 预览是建议值:导入仍走 center 单写路,落库的 id/title 以回执为准;推导若与中心
 * 漂移,导入后的行读会立刻暴露真实值。公式两头任一改动都该先改这里(测试锁形状)。
 */

/** daemon 侧的标题规则:首个 `# ` 标题,否则去掉扩展名的文件名。 */
export function firstMarkdownHeading(content: string): string | null {
  return /^#\s+(.+)$/mu.exec(content)?.[1]?.trim() ?? null;
}

export function titleOfFileLocator(content: string, path: string): string {
  const base = path.split("/").at(-1) ?? path;
  const withoutExtension = base.replace(/\.[^./]*$/u, "");
  return firstMarkdownHeading(content) ?? (withoutExtension || base);
}

/** 目录:有 README.md 用它的首标题,否则目录名。readmeContent 为 null 表示没有 README.md。 */
export function titleOfDirectoryLocator(readmeContent: string | null, path: string): string {
  if (readmeContent !== null) {
    const heading = firstMarkdownHeading(readmeContent);
    if (heading) return heading;
  }
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

export function sourceIdentityOf(repoId: string, locatorPath: string): string {
  return `repo:${repoId}:${locatorPath}`;
}

/** kernel `deriveArtifactEntityId` 的同式;sha256 用 WebCrypto(渲染层无 node:crypto)。 */
export async function deriveEntityId(repoId: string, idPrefix: string, locatorPath: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sourceIdentityOf(repoId, locatorPath)));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${idPrefix}-${hex.slice(0, 16)}`;
}

/**
 * 目录目标要预览标题时需要 README.md 的正文:目录列举回来后,条目里有 README.md
 * 才值得再发一次文件读。这个谓词让「是否多读一次」与 daemon 侧「只认 README.md
 * (大小写敏感)」同判据。
 */
export function directoryHasReadme(entries: readonly { readonly path: string }[]): string | null {
  const hit = entries.find(({ path }) => path.split("/").at(-1) === "README.md");
  return hit === undefined ? null : hit.path;
}
