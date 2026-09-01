/**
 * 终端链接的纯函数判定(PLT-TerminalWorkspace W2)。
 *
 * URL(http/https)由官方 @xterm/addon-web-links 识别,本模块不建第二套 URL 检测,
 * 只做两件事:
 *   1. findTerminalLinks:一行文本里的仓库路径(± `:line`)与台账实体 id → 带偏移的匹配;
 *   2. terminalLinkTargetOf:匹配 → 打开动作(实体引用,或文档绝对路径)。
 * 不依赖 xterm,识别边界与路由分发给 vitest 直接覆盖(见 test/terminal-links.vitest.ts)。
 */

/** 实体 id 形态:task/decision 是 ULID 或十六进制(≥8 位字母数字);fact 锚点定长 8 位大写。 */
const ENTITY_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly ref: (id: string) => string;
}> = [
  { pattern: /\btask_([0-9A-Za-z]{8,})/gu, ref: (id) => `task/${id}` },
  { pattern: /\bdec_([0-9A-Za-z]{8,})/gu, ref: (id) => `decision/${id}` },
  { pattern: /\bF-([0-9A-Z]{8})(?![0-9A-Za-z])/gu, ref: (id) => `fact/F-${id}` },
];

/** URL 只用来占位阻挡(与 addon 的 http/https 口径一致),不让路径/实体匹配吞进 URL 内部。 */
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>`]+/giu;

/** 目录段:字母数字与常见文件名字符。 */
const SEGMENT = "[A-Za-z0-9_.+@~-]+";
/** 末段必须是带扩展名的文件名(含点、不以点收尾),目录与无扩展名路径不产生链接。 */
const FILENAME = "[A-Za-z0-9_+-]+(?:\\.[A-Za-z0-9_+-]+)+";
/** 可选 `:line`/`:line:col` 后缀(整段捕获,便于从原文中剥掉)。 */
const LINE_SUFFIX = "((?::\\d+(?::\\d+)?)?)";
const PATH_PATTERN = new RegExp(
  "(?<![0-9A-Za-z_.~/-])" +
    "(?:(?:\\.\\./|\\./|~/|/)(?:" +
    SEGMENT +
    "/)*" +
    FILENAME +
    "|(?:" +
    SEGMENT +
    "/)+" +
    FILENAME +
    ")" +
    LINE_SUFFIX,
  "gu",
);

/** 台账实体路径(repo 相对)→ 实体引用;harness/ 前缀可选(ledger packagePath 口径是 tasks/<pkg>)。 */
const LEDGER_ENTITY_PATHS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly ref: (id: string) => string;
}> = [
  { pattern: /^(?:harness\/)?tasks\/task_([0-9A-Za-z]{8,})(?:-[^/]*)?\//u, ref: (id) => `task/${id}` },
  { pattern: /^harness\/decisions\/decision-dec_([0-9A-Za-z]{8,})\//u, ref: (id) => `decision/${id}` },
  { pattern: /^harness\/facts\/F-([0-9A-Z]{8})\./u, ref: (id) => `fact/F-${id}` },
];

export type TerminalLinkMatch =
  | { readonly kind: "entity"; readonly ref: string; readonly start: number; readonly end: number }
  | {
      readonly kind: "path";
      readonly path: string;
      readonly line: number | null;
      readonly start: number;
      readonly end: number;
    };

export type TerminalLinkAction =
  | { readonly kind: "entity"; readonly ref: string }
  | { readonly kind: "document"; readonly path: string };

export interface TerminalLinkContext {
  /** 仓库(canonical)根的绝对路径;repo 相对路径的实体映射与文档解析的兜底基座。 */
  readonly repoRoot: string | null;
  /** 会话 cwd(daemon 侧绝对路径);相对路径优先按它解析。 */
  readonly cwd: string | null;
}

/**
 * 一行文本 → 链接匹配(按出现顺序)。重叠时的取舍:URL 段整体让给 web-links;
 * 其余按起点升序、同起点长者优先,先到先得——任务包路径保住整条路径(压过其中的
 * task id),URL 内部的伪路径/伪 id 一律不产链接。
 */
export function findTerminalLinks(text: string): readonly TerminalLinkMatch[] {
  const taken = new Array<boolean>(text.length).fill(false);
  for (const found of text.matchAll(URL_PATTERN))
    for (let i = found.index ?? 0; i < (found.index ?? 0) + found[0].length; i += 1) taken[i] = true;

  const candidates: { readonly match: TerminalLinkMatch; readonly start: number; readonly end: number }[] = [];
  for (const { pattern, ref } of ENTITY_PATTERNS)
    for (const found of text.matchAll(pattern)) {
      const start = found.index ?? 0;
      const end = start + found[0].length;
      candidates.push({ match: { kind: "entity", ref: ref(found[1] ?? ""), start, end }, start, end });
    }
  for (const found of text.matchAll(PATH_PATTERN)) {
    const suffix = found[1] ?? "";
    const start = found.index ?? 0;
    const end = start + found[0].length;
    candidates.push({
      match: {
        kind: "path",
        path: found[0].slice(0, found[0].length - suffix.length),
        line: suffix.length > 0 ? Number(suffix.slice(1).split(":")[0]) : null,
        start,
        end,
      },
      start,
      end,
    });
  }
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);

  const accepted: TerminalLinkMatch[] = [];
  for (const candidate of candidates) {
    if (taken.slice(candidate.start, candidate.end).includes(true)) continue;
    for (let i = candidate.start; i < candidate.end; i += 1) taken[i] = true;
    accepted.push(candidate.match);
  }
  return accepted;
}

/**
 * 匹配 → 打开动作:实体 → canonical 引用(App 经 navigateToEntity 推栈);路径 →
 * 台账实体路径映射实体详情,其余解析为绝对路径交文档预览。绝对/`~` 路径原样交预览
 * (主进程只读桥负责 `~` 展开与存在性校验);相对路径按 cwd、其次 repoRoot 解析,
 * 两者都缺时返回 null(调用方降级为复制原文)。
 */
export function terminalLinkTargetOf(
  match: TerminalLinkMatch,
  context: TerminalLinkContext,
): TerminalLinkAction | null {
  if (match.kind === "entity") return { kind: "entity", ref: match.ref };
  if (match.path.startsWith("/") || match.path.startsWith("~")) return { kind: "document", path: match.path };
  const base = context.cwd ?? context.repoRoot;
  if (base === null || base.length === 0) return null;
  const normalized = normalizeRelative(match.path);
  const entity = ledgerEntityRefOf(normalized) ?? entityUnderRoot(base, normalized, context.repoRoot);
  return entity ?? { kind: "document", path: resolveRelative(base, match.path) };
}

/** 相对路径的词法归一:折叠 `.`/`..`,剥掉 `./` 前缀(`..` 不设下限,解析为绝对路径后再校验)。 */
function normalizeRelative(relative: string): string {
  const segments: string[] = [];
  for (const segment of relative.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

/** 以 base 为基座解析相对路径;`..` 折到根为止(存在性由文档预览的只读校验兜底)。 */
function resolveRelative(base: string, relative: string): string {
  const segments = base.replace(/\/+$/u, "").split("/");
  for (const segment of normalizeRelative(relative).split("/")) if (segment.length > 0) segments.push(segment);
  return segments.join("/");
}

/** cwd 与 repoRoot 不同(worktree)时,cwd 解析结果若仍落在本仓内,再试一次实体映射。 */
function entityUnderRoot(base: string, normalized: string, repoRoot: string | null): TerminalLinkAction | null {
  if (repoRoot === null || repoRoot.length === 0) return null;
  const resolved = resolveRelative(base, normalized);
  const prefix = repoRoot.replace(/\/+$/u, "") + "/";
  return resolved.startsWith(prefix) ? ledgerEntityRefOf(resolved.slice(prefix.length)) : null;
}

function ledgerEntityRefOf(relative: string): TerminalLinkAction | null {
  for (const { pattern, ref } of LEDGER_ENTITY_PATHS) {
    const found = pattern.exec(relative);
    if (found !== null) return { kind: "entity", ref: ref(found[1] ?? "") };
  }
  return null;
}
