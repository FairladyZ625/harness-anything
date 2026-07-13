import { describe, expect, it } from "vitest";
import {
  buildDocTree,
  collectDirectoryPaths,
} from "../src/renderer/model/docTree.ts";
import type { DocEntry } from "../src/renderer/model/types.ts";

/**
 * 文档路径分段树测试。
 *
 * 后端放开后 documents DTO 含递归路径(artifacts/orchestration/report.md)。
 * 原来的 inferDocGroup 把没匹配上的路径全倒进「进度」兜底桶。本测试验证
 * buildDocTree 按真实目录结构建树,支持多层嵌套。
 */

function doc(path: string, overrides: Partial<DocEntry> = {}): DocEntry {
  return {
    path,
    title: path.split("/").pop() ?? path,
    group: "progress",
    required: false,
    present: true,
    ...overrides,
  };
}

describe("buildDocTree basic structure", () => {
  it("renders flat files as root-level leaves", () => {
    const tree = buildDocTree([
      doc("INDEX.md"),
      doc("progress.md"),
    ]);
    expect(tree).toHaveLength(2);
    expect(tree.every((n) => !n.isDir)).toBe(true);
    expect(tree.map((n) => n.path)).toEqual(["INDEX.md", "progress.md"]);
  });

  it("returns an empty array for no documents", () => {
    expect(buildDocTree([])).toEqual([]);
  });
});

describe("buildDocTree nested directories", () => {
  const tree = buildDocTree([
    doc("INDEX.md"),
    doc("progress.md"),
    doc("plan/task-plan.md"),
    doc("artifacts/findings.md"),
    doc("artifacts/orchestration/report.md"),
    doc("artifacts/orchestration/notes.md", { present: false }),
  ]);

  it("groups files under their parent directories", () => {
    // Root: 2 dirs (artifacts, plan) + 2 files (INDEX, progress) — dirs first
    expect(tree.map((n) => n.name)).toEqual([
      "artifacts",
      "plan",
      "INDEX.md",
      "progress.md",
    ]);

    const artifacts = tree[0];
    expect(artifacts.isDir).toBe(true);
    expect(artifacts.children.map((n) => n.name)).toEqual([
      "orchestration",
      "findings.md",
    ]);

    const orchestration = artifacts.children[0];
    expect(orchestration.isDir).toBe(true);
    expect(orchestration.children.map((n) => n.name)).toEqual([
      "notes.md",
      "report.md",
    ]);
  });

  it("preserves DocEntry on leaf nodes (present/required/title)", () => {
    const artifacts = tree[0];
    const orchestration = artifacts.children[0];
    const notes = orchestration.children[0];
    expect(notes.doc?.present).toBe(false);
    expect(notes.doc?.path).toBe("artifacts/orchestration/notes.md");

    const report = orchestration.children[1];
    expect(report.doc?.present).toBe(true);
  });

  it("sets isDir=false on leaf nodes and isDir=true on branch nodes", () => {
    const plan = tree[1];
    expect(plan.isDir).toBe(true);
    expect(plan.children[0].isDir).toBe(false);
  });

  it("sorts directories before files, alphabetical within each group", () => {
    // At root: artifacts/ and plan/ (dirs) before INDEX.md and progress.md (files)
    expect(tree[0].isDir).toBe(true);
    expect(tree[1].isDir).toBe(true);
    expect(tree[2].isDir).toBe(false);
    expect(tree[3].isDir).toBe(false);
    expect(tree[0].name).toBe("artifacts");
    expect(tree[1].name).toBe("plan");
  });
});

describe("buildDocTree deep nesting", () => {
  it("handles arbitrarily deep paths (4+ levels)", () => {
    const tree = buildDocTree([
      doc("a/b/c/d/e.md"),
      doc("a/b/f.md"),
      doc("a/g.md"),
    ]);

    expect(tree).toHaveLength(1);
    const a = tree[0];
    expect(a.name).toBe("a");
    expect(a.children.map((n) => n.name)).toEqual(["b", "g.md"]);

    const b = a.children[0];
    expect(b.children.map((n) => n.name)).toEqual(["c", "f.md"]);

    const c = b.children[0];
    expect(c.children.map((n) => n.name)).toEqual(["d"]);

    const d = c.children[0];
    expect(d.children.map((n) => n.name)).toEqual(["e.md"]);
    expect(d.children[0].doc?.path).toBe("a/b/c/d/e.md");
  });

  it("merges files at different depths under the same ancestor", () => {
    const tree = buildDocTree([
      doc("artifacts/top.md"),
      doc("artifacts/deep/inner.md"),
    ]);

    const artifacts = tree[0];
    expect(artifacts.children.map((n) => n.name)).toEqual(["deep", "top.md"]);
    expect(artifacts.children[0].children[0].doc?.path).toBe("artifacts/deep/inner.md");
  });
});

describe("buildDocTree title display", () => {
  it("uses DocEntry.title for file display name, not raw filename", () => {
    const tree = buildDocTree([
      doc("plan/task-plan.md", { title: "任务计划" }),
    ]);
    const plan = tree[0];
    expect(plan.name).toBe("plan"); // directory uses segment name
    expect(plan.children[0].name).toBe("任务计划"); // file uses title
  });
});

describe("collectDirectoryPaths", () => {
  it("collects directory paths up to maxDepth", () => {
    const tree = buildDocTree([
      doc("a/b.md"),
      doc("x/y/z.md"),
    ]);

    // depth 0: top-level dirs only
    expect(collectDirectoryPaths(tree, 0).sort()).toEqual(["a", "x"]);

    // depth 1: include second-level dirs
    expect(collectDirectoryPaths(tree, 1).sort()).toEqual(["a", "x", "x/y"]);
  });

  it("with maxDepth=0 returns only root directories (for default expand)", () => {
    const tree = buildDocTree([
      doc("artifacts/inner/deep.md"),
      doc("plan/task.md"),
    ]);
    const rootDirs = collectDirectoryPaths(tree, 0);
    expect(rootDirs.sort()).toEqual(["artifacts", "plan"]);
  });
});
