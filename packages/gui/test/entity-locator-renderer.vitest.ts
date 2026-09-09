// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import {
  isDirectoryLocator,
  isHtmlDocument,
  isMarkdownDocument,
  isPdfDocument,
  selectEntityLocatorRenderer,
} from "../src/renderer/entity-locator-renderer.ts";
import {
  directoryHasReadme,
  firstMarkdownHeading,
  sourceIdentityOf,
  titleOfDirectoryLocator,
  titleOfFileLocator,
} from "../src/renderer/entity-import-preview.ts";

/**
 * 渲染器选择表是 GUI 里**唯一**一处按 locator 判渲染器的地方。这里锁住那张表:
 * 每一行一个判据,外加三条阴性——压缩包、目录、非仓内指针都不得落进 Markdown。
 * 同一文件还锁住导入预览的推导:title/id 公式必须与 kernel/daemon 侧一致,
 * GUI 不得自己发明第二套。
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

  it("routes pdf pointers to the dedicated pdf surface, not the opaque card", () => {
    // pdf 不是「渲染不了」而是「读面给不了字节」:有自己的事实卡,与 zip/图片分开。
    for (const value of ["papers/report.pdf", "papers/Report.PDF"])
      expect(selectEntityLocatorRenderer({ kind: "repository-path", value }), value).toBe("pdf");
    expect(isPdfDocument("a.pdf")).toBe(true);
    expect(isPdfDocument("a.md")).toBe(false);
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

/**
 * 源身份是中心真的会冻结的那一条;实例身份不在这里推导——它是中心接受时铸的 128 bit
 * 随机值,渲染层算不出来,也不该假装算得出来。
 */
describe("source identity", () => {
  it("derives the source identity the kernel would freeze", () => {
    expect(sourceIdentityOf("harness-anything", "harness/context/research/x")).toBe(
      "repo:harness-anything:harness/context/research/x",
    );
  });
});

describe("derived title", () => {
  it("prefers the first markdown heading, then the file name without extension", () => {
    expect(titleOfFileLocator("# 协调一致性\n\n正文", "docs/x/coordination.md")).toBe("协调一致性");
    expect(titleOfFileLocator("没有标题的正文", "docs/x/coordination-notes.md")).toBe("coordination-notes");
  });

  it("heading rule only accepts a level-one heading at line start", () => {
    expect(firstMarkdownHeading("## 二级不算\n# 一级才算")).toBe("一级才算");
    expect(firstMarkdownHeading("正文\n\n# 段落后的标题")).toBe("段落后的标题");
    expect(firstMarkdownHeading("无标题")).toBeNull();
  });

  it("directory title prefers README.md heading, then the directory name", () => {
    expect(titleOfDirectoryLocator("# 研究包说明", "harness/context/research/2026-09-05-x")).toBe("研究包说明");
    expect(titleOfDirectoryLocator(null, "harness/context/research/2026-09-05-x")).toBe("2026-09-05-x");
    expect(titleOfDirectoryLocator("README 没有标题", "harness/context/research/2026-09-05-x")).toBe("2026-09-05-x");
  });

  it("readme detection matches the daemon rule: exact README.md, case sensitive", () => {
    const entries = [{ path: "pkg/readme.md" }, { path: "pkg/README.md" }];
    expect(directoryHasReadme(entries)).toBe("pkg/README.md");
    expect(directoryHasReadme([{ path: "pkg/readme.md" }])).toBeNull();
    expect(directoryHasReadme([])).toBeNull();
  });
});
