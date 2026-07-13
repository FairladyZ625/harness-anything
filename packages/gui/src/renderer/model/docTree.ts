import type { DocEntry } from "./types.ts";

/**
 * 文档路径分段树。
 *
 * 后端放开后 documents DTO 含递归路径(artifacts/orchestration/report.md)。
 * 原来的 inferDocGroup 把没匹配上的路径全倒进「进度」兜底桶,多层子目录全糊在一起。
 * 本模块按真实目录结构建树,让用户能展开 artifacts/ 及更深子目录。
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

/**
 * 从扁平文档列表构建路径树。按目录优先 + 字母序排序。
 *
 * 形如:
 *   artifacts/           (dir)
 *     findings.md        (file)
 *     orchestration/     (dir)
 *       notes.md         (file)
 *       report.md        (file)
 *   INDEX.md             (file)
 *   plan/                (dir)
 *     task-plan.md       (file)
 */
export function buildDocTree(docs: readonly DocEntry[]): DocTreeNode[] {
  const root = buildTrie(docs);
  return flattenAndSort(root);
}

function buildTrie(docs: readonly DocEntry[]): Map<string, TrieNode> {
  const root: Map<string, TrieNode> = new Map();
  for (const doc of docs) {
    const segments = doc.path.split("/").filter((s) => s.length > 0);
    let level = root;
    let path = "";
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      path = path ? `${path}/${seg}` : seg;
      const isLeaf = i === segments.length - 1;
      if (!level.has(seg)) {
        const node: TrieNode = {
          name: seg,
          path,
          children: new Map(),
        };
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
