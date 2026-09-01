// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import {
  classifyMarkdownHref,
  fileUrlToPathString,
  markdownUrlTransform,
  resolveRepoDocPath,
} from "../src/renderer/local-doc/markdown-links.ts";

/**
 * 详情页 Markdown 链接归类(task_89d324b5):锚点永不导航,本机文件走 GUI 内读取,
 * 包内相对链接归一化到任务包内,网页与其余形态 inert。
 */
describe("classifyMarkdownHref", () => {
  it("treats absolute, home-tilde and file:// hrefs as local files", () => {
    expect(classifyMarkdownHref("/Users/ce/Notes/spec.md")).toEqual({
      kind: "local-file",
      path: "/Users/ce/Notes/spec.md",
    });
    expect(classifyMarkdownHref("~/Notes/spec.md")).toEqual({ kind: "local-file", path: "~/Notes/spec.md" });
    expect(classifyMarkdownHref("file:///Users/ce/a%20b.md")).toEqual({
      kind: "local-file",
      path: "/Users/ce/a b.md",
    });
  });

  it("keeps web links web and never classifies scripts as openable", () => {
    expect(classifyMarkdownHref("https://example.invalid/doc")).toEqual({
      kind: "web",
      href: "https://example.invalid/doc",
    });
    expect(classifyMarkdownHref("mailto:ce@example.invalid")).toEqual({
      kind: "web",
      href: "mailto:ce@example.invalid",
    });
    expect(classifyMarkdownHref("javascript:alert(1)").kind).toBe("inert");
    expect(classifyMarkdownHref("data:text/html,boom").kind).toBe("inert");
    expect(classifyMarkdownHref("blob:https://x/y").kind).toBe("inert");
  });

  it("resolves package-relative links only when a package base path is provided", () => {
    expect(classifyMarkdownHref("artifacts/report.md")).toEqual({ kind: "inert", href: "artifacts/report.md" });
    expect(classifyMarkdownHref("artifacts/report.md", { packageBasePath: "tasks/pkg/task_plan.md" })).toEqual({
      kind: "package-doc",
      path: "tasks/pkg/artifacts/report.md",
    });
    expect(classifyMarkdownHref("sub/../closeout.md", { packageBasePath: "tasks/pkg/task_plan.md" })).toEqual({
      kind: "package-doc",
      path: "tasks/pkg/closeout.md",
    });
    // `..` 越出包根不落点:归一化若继续会把包外路径静默改写成包内同名文件,拒绝。
    expect(classifyMarkdownHref("../../outside.md", { packageBasePath: "tasks/pkg/a.md" }).kind).toBe("inert");
    expect(classifyMarkdownHref("#anchor", { packageBasePath: "tasks/pkg/a.md" }).kind).toBe("inert");
  });
});

describe("fileUrlToPathString", () => {
  it("accepts empty and localhost hosts only, decoding percent escapes", () => {
    expect(fileUrlToPathString("file:///Users/ce/x.md")).toBe("/Users/ce/x.md");
    expect(fileUrlToPathString("file://localhost/Users/ce/x.md")).toBe("/Users/ce/x.md");
    expect(fileUrlToPathString("file://nas/share/x.md")).toBeNull();
    expect(fileUrlToPathString("https://example.invalid/x")).toBeNull();
  });
});

describe("resolveRepoDocPath", () => {
  it("normalizes dot segments inside the package and refuses escapes", () => {
    expect(resolveRepoDocPath("tasks/pkg/a.md", "b/c.md")).toBe("tasks/pkg/b/c.md");
    expect(resolveRepoDocPath("tasks/pkg/sub/a.md", "../b.md")).toBe("tasks/pkg/b.md");
    expect(resolveRepoDocPath("tasks/pkg/a.md", "./x.md")).toBe("tasks/pkg/x.md");
    expect(resolveRepoDocPath("tasks/pkg/a.md", "../../x.md")).toBeNull();
    expect(resolveRepoDocPath(null, "x.md")).toBeNull();
  });
});

describe("markdownUrlTransform", () => {
  it("keeps the react-markdown allowlist and additionally admits file://", () => {
    expect(markdownUrlTransform("https://example.invalid/a")).toBe("https://example.invalid/a");
    expect(markdownUrlTransform("file:///Users/ce/a.md")).toBe("file:///Users/ce/a.md");
    expect(markdownUrlTransform("artifacts/a.md")).toBe("artifacts/a.md");
    expect(markdownUrlTransform("/Users/ce/a.md")).toBe("/Users/ce/a.md");
    expect(markdownUrlTransform("javascript:alert(1)")).toBe("");
    expect(markdownUrlTransform("data:text/html,x")).toBe("");
    expect(markdownUrlTransform("vbscript:evil")).toBe("");
  });
});
