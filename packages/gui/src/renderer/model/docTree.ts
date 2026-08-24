import type { DocEntry } from "./types.ts";

/**
 * 文档路径分段树。
 *
 * 文档清单来自 repo.tasks.documents.list 投影(路径相对任务包根,
 * 含 artifacts/ 等递归子目录)。原来的 6-组扁平分组把没匹配上的路径全倒进
 * 兜底桶,多层子目录糊在一起;本模块按真实目录结构建树,artifacts/ 及更深
 * 子目录可展开。
 *
 * 纯函数,不挂 React,vitest 直接覆盖。
 */

export interface DocTreeNode {
  /** 展示名:文件用 DocEntry.title,目录用路径分段。 */
  name: string;
  /** 完整路径(文件=文档路径,目录=目录前缀)。 */
  path: string;
  isDir: boolean;
  /** 仅叶子节点有:对应的文档条目。 */
  doc?: DocEntry;
  children: DocTreeNode[];
}

interface TrieNode {
  name: string;
  path: string;
  doc?: DocEntry;
  children: Map<string, TrieNode>;
}

/** 投影清单 → 文档条目。投影列出的文件都在磁盘上,所以恒为 present 且非 required。 */
export function projectedDocuments(projectedPaths: ReadonlyArray<string>): DocEntry[] {
  return projectedPaths.map((path) => ({
    path,
    title: path.split("/").at(-1) ?? path,
    group: inferDocGroup(path),
    required: false,
    present: true,
    presence: "present" as const,
  }));
}

/** 投影补充文件的分组:artifacts/ 归证据,其余归进度(仅作面包屑标签,导航已改用目录树)。 */
function inferDocGroup(path: string): DocEntry["group"] {
  return path.startsWith("artifacts/") ? "证据" : "进度";
}

/**
 * 从扁平文档列表构建路径树。按目录优先 + 字母序排序。
 *
 * 形如:
 *   artifacts/           (dir)
 *     findings.md        (file)
 *     orchestration/     (dir)
 *       report.md        (file)
 *   INDEX.md             (file)
 */
export function buildDocTree(docs: readonly DocEntry[]): DocTreeNode[] {
  const visible = docs.filter((doc) => !isIgnoredDoc(doc.path));
  const root = buildTrie(visible);
  return flattenAndSort(root);
}

/**
 * 忽略仅用于版本控制占位、非用户内容的文件。
 * `.gitkeep` 只是为让空目录进 git 而存在,展示给用户没有意义。
 * 若某目录仅含 `.gitkeep`,过滤后该目录不再入 trie,空目录一并隐去。
 */
function isIgnoredDoc(path: string): boolean {
  const base =
    path
      .split("/")
      .filter((s) => s.length > 0)
      .pop() ?? "";
  return base === ".gitkeep";
}

function buildTrie(docs: readonly DocEntry[]): Map<string, TrieNode> {
  const root: Map<string, TrieNode> = new Map();
  for (const doc of docs) {
    const segments = doc.path.split("/").filter((s) => s.length > 0);
    let level = root;
    let path = "";
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      path = path ? `${path}/${seg}` : seg;
      const isLeaf = i === segments.length - 1;
      if (!level.has(seg)) {
        const node: TrieNode = { name: seg, path, children: new Map() };
        if (isLeaf) node.doc = doc;
        level.set(seg, node);
      } else if (isLeaf) {
        // 已作为目录存在,现在发现它也是文件(文件系统不会这样,但防御性处理)
        level.get(seg)!.doc = doc;
      }
      level = level.get(seg)!.children;
    }
  }
  return root;
}

function flattenAndSort(nodes: Map<string, TrieNode>): DocTreeNode[] {
  const result: DocTreeNode[] = [];
  for (const node of nodes.values()) {
    const children = flattenAndSort(node.children);
    result.push({
      name: node.doc?.title ?? node.name,
      path: node.path,
      isDir: children.length > 0,
      doc: node.doc,
      children,
    });
  }
  return sortNodes(result);
}

/** 目录优先,同类按名字字母序。 */
function sortNodes(nodes: DocTreeNode[]): DocTreeNode[] {
  return nodes.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** 收集树中所有目录路径(用于默认展开根级目录)。 */
export function collectDirectoryPaths(nodes: readonly DocTreeNode[], maxDepth = 0): string[] {
  const paths: string[] = [];
  function walk(node: DocTreeNode, depth: number) {
    if (node.isDir && depth <= maxDepth) {
      paths.push(node.path);
      for (const child of node.children) walk(child, depth + 1);
    }
  }
  for (const node of nodes) walk(node, 0);
  return paths;
}
