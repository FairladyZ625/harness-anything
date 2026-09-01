// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import {
  findTerminalLinks,
  terminalLinkTargetOf,
  type TerminalLinkMatch,
} from "../src/renderer/components/terminal/terminal-links.ts";

function matchesOf(text: string): readonly TerminalLinkMatch[] {
  return findTerminalLinks(text);
}

describe("findTerminalLinks:识别正例(路径 / 实体 id)", () => {
  it.each([
    // [文本, 期望 kind, 期望载荷]
    [
      "edit packages/gui/src/renderer/App.tsx:123 next",
      "path",
      { path: "packages/gui/src/renderer/App.tsx", line: 123 },
    ],
    ["open ./docs/report.md:4:9 done", "path", { path: "./docs/report.md", line: 4 }],
    ["see /Users/ce/Notes/spec.md now", "path", { path: "/Users/ce/Notes/spec.md", line: null }],
    ["cat ~/notes/a.md", "path", { path: "~/notes/a.md", line: null }],
    ["../src/main.ts moved", "path", { path: "../src/main.ts", line: null }],
    ["task_e09781af69235f51c1eecf64b2 done", "entity", { ref: "task/e09781af69235f51c1eecf64b2" }],
    ["per dec_60AF05D4F52CEFE347F2208791 yes", "entity", { ref: "decision/60AF05D4F52CEFE347F2208791" }],
    ["fact F-84CF0391 recorded", "entity", { ref: "fact/F-84CF0391" }],
  ] as const)("%s → %s %j", (text, kind, expected) => {
    const found = matchesOf(text);
    expect(found).toHaveLength(1);
    if (kind === "path") expect(found[0]).toMatchObject({ kind, ...expected });
    else expect(found[0]).toMatchObject({ kind, ...expected });
  });

  it("keeps the full task package path over the embedded task id (先到先得,长者优先)", () => {
    const found = matchesOf("open harness/tasks/task_01cb8cf64ad28a48b4a7506b85-w3-g34/task_plan.md now");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: "path",
      path: "harness/tasks/task_01cb8cf64ad28a48b4a7506b85-w3-g34/task_plan.md",
    });
  });
});

describe("findTerminalLinks:识别负例(不产生链接)", () => {
  it.each([
    ["run npm run check:local now"],
    ["see https://example.com/packages/gui/src/renderer/App.tsx online"], // URL 整体归 web-links
    ["task_abc123 pending"], // id 不足 8 位
    ["F-84CF03 bad"], // fact 锚点不足 8 位
    ["cd packages/gui/src/renderer"], // 目录无扩展名
    ["read README.md please"], // 裸文件名无目录段
    ["at 12:30 sharp"], // 时间
  ])("%s", (text) => {
    expect(matchesOf(text)).toEqual([]);
  });

  it("rejects an id that is a prefix of a longer id (fact 锚点定长 8 位)", () => {
    expect(matchesOf("F-84CF0391AB extra")).toEqual([]);
  });
});

describe("terminalLinkTargetOf:匹配 → 打开动作", () => {
  it("maps ledger entity paths to entity refs with or without the harness/ prefix", () => {
    const taskPath = matchesOf("harness/tasks/task_e09781af69235f51c1eecf64b2-terminal-links-w2/task_plan.md")[0]!;
    expect(terminalLinkTargetOf(taskPath, { repoRoot: "/repo", cwd: "/repo/packages/gui" })).toEqual({
      kind: "entity",
      ref: "task/e09781af69235f51c1eecf64b2",
    });
    const decisionPath = matchesOf("harness/decisions/decision-dec_60AF05D4F52CEFE347F2208791/body.md")[0]!;
    expect(terminalLinkTargetOf(decisionPath, { repoRoot: "/repo", cwd: null })).toEqual({
      kind: "entity",
      ref: "decision/60AF05D4F52CEFE347F2208791",
    });
    const factPath = matchesOf("harness/facts/F-00065A36.md")[0]!;
    expect(terminalLinkTargetOf(factPath, { repoRoot: "/repo", cwd: null })).toEqual({
      kind: "entity",
      ref: "fact/F-00065A36",
    });
  });

  it("resolves relative paths against the session cwd first, then the repo root", () => {
    const link = matchesOf("src/main.ts")[0]!;
    expect(terminalLinkTargetOf(link, { repoRoot: "/repo/a", cwd: "/repo/a/packages/gui" })).toEqual({
      kind: "document",
      path: "/repo/a/packages/gui/src/main.ts",
    });
    expect(terminalLinkTargetOf(link, { repoRoot: "/repo/a", cwd: null })).toEqual({
      kind: "document",
      path: "/repo/a/src/main.ts",
    });
  });

  it("folds .. segments against the base and maps to the task entity when still inside the repo", () => {
    const link = matchesOf("../harness/tasks/task_01cb8cf64ad28a48b4a7506b85-w3-g34/closeout.md")[0]!;
    expect(terminalLinkTargetOf(link, { repoRoot: "/repo/a", cwd: "/repo/a/packages/gui" })).toEqual({
      kind: "entity",
      ref: "task/01cb8cf64ad28a48b4a7506b85",
    });
  });

  it("passes absolute and ~ paths straight to the document preview", () => {
    const absolute = matchesOf("/Users/ce/Notes/spec.md:9")[0]!;
    expect(terminalLinkTargetOf(absolute, { repoRoot: null, cwd: null })).toEqual({
      kind: "document",
      path: "/Users/ce/Notes/spec.md",
    });
    const home = matchesOf("~/notes/a.md")[0]!;
    expect(terminalLinkTargetOf(home, { repoRoot: "/repo", cwd: "/repo" })).toEqual({
      kind: "document",
      path: "~/notes/a.md",
    });
  });

  it("returns null for relative paths when neither cwd nor repo root is known (调用方降级复制)", () => {
    const link = matchesOf("src/main.ts")[0]!;
    expect(terminalLinkTargetOf(link, { repoRoot: null, cwd: null })).toBeNull();
  });
});
