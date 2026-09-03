// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import {
  isDirectoryLocator,
  isHtmlDocument,
  isMarkdownDocument,
  selectEntityLocatorRenderer,
} from "../src/renderer/entity-locator-renderer.ts";

/**
 * 渲染器选择表是 GUI 里**唯一**一处按 locator 判渲染器的地方。这里锁住那张表:
 * 每一行一个判据,外加三条阴性——压缩包、目录、非仓内指针都不得落进 Markdown。
 */
describe("entity locator renderer table", () => {
  it("routes markdown pointers to the markdown renderer", () => {
    for (const value of ["harness/adr/ADR-0020-decision-entity-adr-boundary.md", "README.markdown", "a/b/C.MD"])
      expect(selectEntityLocatorRenderer({ kind: "repository-path", value }), value).toBe("markdown");
  });

  it("routes html pointers to the html artifact preview", () => {
    for (const value of ["reports/summary.html", "reports/summary.HTM"])
      expect(selectEntityLocatorRenderer({ kind: "repository-path", value }), value).toBe("html");
  });

  it("routes directory pointers to the directory surface", () => {
    for (const value of ["harness/research", "harness/research/", "docs/adr/"])
      expect(selectEntityLocatorRenderer({ kind: "repository-path", value }), value).toBe("directory");
  });

  it("does not pretend to render what it cannot", () => {
    // 压缩包与图片:元数据卡,不是 Markdown。
    for (const value of ["archives/bundle.zip", "images/shot.png", "data/rows.csv"])
      expect(selectEntityLocatorRenderer({ kind: "repository-path", value }), value).toBe("opaque");
  });

  it("treats non repository-path locators as opaque regardless of their extension", () => {
    // url 指针即使以 .md 结尾也不是仓内文件——渲染器表按 locator kind 先判,不看后缀。
    expect(selectEntityLocatorRenderer({ kind: "url", value: "https://example.com/spec.md" })).toBe("opaque");
    expect(selectEntityLocatorRenderer({ kind: "external-key", value: "JIRA-1234" })).toBe("opaque");
  });

  it("exposes the three predicates the table is built from", () => {
    expect(isHtmlDocument("a.html")).toBe(true);
    expect(isHtmlDocument("a.md")).toBe(false);
    expect(isMarkdownDocument("a.md")).toBe(true);
    expect(isMarkdownDocument("a.html")).toBe(false);
    expect(isDirectoryLocator("harness/research")).toBe(true);
    expect(isDirectoryLocator("harness/research/notes.md")).toBe(false);
  });
});
