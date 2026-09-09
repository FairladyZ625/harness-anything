import { consumeKnownError } from "../api/error-consumption.ts";

/**
 * 新建实体的预览推导(task_a494eac2 Goal 1)。
 *
 * title = 目录 README.md 首标题 / 文件首行 `# 标题` / 文件名(daemon `resolveArtifactSource`
 * + `titleFromContent`)。预览是建议值:导入仍走 center 单写路,落库的 title 以回执为准。
 *
 * **entity id 不在这里推导,也推导不出来。** 实例身份是中心在接受那一刻铸的 128 bit
 * 随机值,不是路径的函数;渲染层再算一遍只能算出一个永远不会被任何事件携带的假 id。
 * 新建实体的真实 id 只有回执里有。
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

/**
 * 目录目标要预览标题时需要 README.md 的正文:目录列举回来后,条目里有 README.md
 * 才值得再发一次文件读。这个谓词让「是否多读一次」与 daemon 侧「只认 README.md
 * (大小写敏感)」同判据。
 */
export function directoryHasReadme(entries: readonly { readonly path: string }[]): string | null {
  const hit = entries.find(({ path }) => path.split("/").at(-1) === "README.md");
  return hit === undefined ? null : hit.path;
}

/**
 * url 指针的 title 规则(daemon `resolveArtifactSource` 的 url 分支):路径末段,末段为空
 * 时退到主机名。url 正文不按 Markdown 首标题取标题——那是仓内文件分支的规则。
 */
export function titleOfUrlLocator(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split("/").filter(Boolean).at(-1) ?? parsed.hostname;
  } catch (cause) {
    // 还没输完的 url 解析不了:预览退到原文,不当成错误——真正的裁决在中心。
    consumeKnownError(cause);
    return url;
  }
}
