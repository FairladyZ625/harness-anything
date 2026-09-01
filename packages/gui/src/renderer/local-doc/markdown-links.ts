import { consumeKnownError } from "../../api/error-consumption.ts";

/**
 * 详情页 Markdown 链接的纯函数判定(task_89d324b5)。
 *
 * 根修的前提:渲染层的 Markdown 锚点永远不做文档导航。此前没有任何拦截:绝对路径链接(`/Users/…`)在 dev 壳里解析到 dev origin
 * 之下后直接把窗口带离应用(落在 dev server 404 上 = 白屏),打包态则被壳拒绝成死链接。这里把每个 href 归到四类去处:
 *   local-file   → 本机文件读取通道(项目外绝对路径/`~`/`file://`)；
 *   package-doc  → 任务包内相对路径(宿主提供当前文档路径时归一化后走包内文档导航)；
 *   web/inert    → 不打开(GUI 不内嵌浏览器，也不新开外部窗口)。
 */

export type MarkdownLinkTarget =
  | { readonly kind: "local-file"; readonly path: string }
  | { readonly kind: "package-doc"; readonly path: string }
  | { readonly kind: "web"; readonly href: string }
  | { readonly kind: "inert"; readonly href: string };

export interface MarkdownLinkContext {
  /** 当前 Markdown 文档在任务包内的 repo 相对路径;提供时相对链接才有包内落点。 */
  readonly packageBasePath?: string | null;
}

const WEB_SCHEMES = /^(?:https?|irc|ircs|mailto|xmpp|tel):/iu;
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/u;
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/u;

/** href → 目标归类;空 href、锥子、未知 scheme 一律 inert(不导航、不报错)。 */
export function classifyMarkdownHref(href: string, context: MarkdownLinkContext = {}): MarkdownLinkTarget {
  const trimmed = href.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return { kind: "inert", href: trimmed };
  if (WEB_SCHEMES.test(trimmed)) return { kind: "web", href: trimmed };
  if (/^file:\/\//iu.test(trimmed)) {
    const path = fileUrlToPathString(trimmed);
    return path === null ? { kind: "inert", href: trimmed } : { kind: "local-file", path };
  }
  if (SCHEME.test(trimmed)) return { kind: "inert", href: trimmed };
  if (trimmed.startsWith("/") || trimmed.startsWith("~/") || trimmed === "~" || WINDOWS_ABSOLUTE.test(trimmed))
    return { kind: "local-file", path: trimmed };
  const resolved = resolveRepoDocPath(context.packageBasePath ?? null, trimmed);
  return resolved === null ? { kind: "inert", href: trimmed } : { kind: "package-doc", path: resolved };
}

/** `file:///a/b%20c` → `/a/b c`;带非 localhost 主机的 file URL 不接受。 */
export function fileUrlToPathString(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") return null;
    if (parsed.host !== "" && parsed.host !== "localhost") return null;
    return decodeURIComponent(parsed.pathname);
  } catch (cause) {
    // URL 解析失败 = 非法 file 链接,按 inert 处理;异常本身是已知形态,消费掉。
    consumeKnownError(cause);
    return null;
  }
}

/**
 * 包内相对路径归一化:`tasks/pkg/task_plan.md` 基座 + `artifacts/x.md` → `tasks/pkg/artifacts/x.md`。
 * `..` 越出包根、或没有基座时返回 null(链接保持 inert,不发起注定要失败的读取)。
 */
export function resolveRepoDocPath(packageBasePath: string | null, href: string): string | null {
  if (packageBasePath === null || packageBasePath.length === 0) return null;
  const segments = packageBasePath.split("/").slice(0, -1);
  // 包根 = `tasks/<pkg>`(daemon 台账的 packagePath 口径)。`..` 只能在包内消化:
  // 越出包根的链接指向包外文件,归一化若继续走会把「包外的 ../../x.md」静默改写成
  // 「包内的 x.md」——打开另一个文件。宁可 null(链接 inert)。
  const floor = segments[0] === "tasks" && segments.length >= 2 ? 2 : 0;
  for (const segment of href.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length <= floor) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const resolved = segments.join("/");
  return resolved.length === 0 ? null : resolved;
}

/**
 * react-markdown 的 urlTransform:默认白名单(http/https/irc/ircs/mailto/xmpp + 相对引用)
 * 之外额外放行 `file://`。锚点不会真的导航(MarkdownAnchor 拦截后转本机读取),
 * `javascript:`/`data:` 等仍被清空。
 */
export function markdownUrlTransform(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) return "";
  if (WEB_SCHEMES.test(trimmed) || /^file:\/\//iu.test(trimmed)) return trimmed;
  if (!SCHEME.test(trimmed)) return trimmed;
  return "";
}
