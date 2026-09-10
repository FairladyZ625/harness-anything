// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import {
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
  titleOfUrlLocator,
} from "../src/renderer/entity-import-preview.ts";

/**
 * 渲染器选择表是 GUI 里**唯一**一处按 locator 判渲染器的地方。这里锁住那张表:
 * 每一行一个判据,外加三条阴性——压缩包、非仓内指针、读不出来的路径都不得落进
 * Markdown。**目录与文件之分由读面的 outcome 说了算**,不由「末段有没有点」猜:
 * 没有扩展名的文件仍是文件,名字里带点的目录仍是目录。
 * 同一文件还锁住导入预览的推导:title/内容根公式必须与 kernel/daemon 侧一致,
 * GUI 不得自己发明第二套;实例 id 不在这里推导。
 */
describe("entity locator renderer table", () => {
  it("routes markdown pointers to the markdown renderer", () => {
    for (const value of ["harness/adr/ADR-0020-decision-entity-adr-boundary.md", "README.markdown", "a/b/C.MD"])
      expect(selectEntityLocatorRenderer({ kind: "repository-path", value }, "file"), value).toBe("markdown");
  });

  it("routes html pointers to the html artifact preview", () => {
    for (const value of ["reports/summary.html", "reports/summary.HTM"])
      expect(selectEntityLocatorRenderer({ kind: "repository-path", value }, "file"), value).toBe("html");
  });

  it("routes pdf pointers to the dedicated pdf surface, not the opaque card", () => {
    // pdf 不是「渲染不了」而是「读面给不了字节」:读面回 binary,pdf 走自己的事实卡,
    // 同样回 binary 的 zip/图片走元数据卡。
    for (const value of ["papers/report.pdf", "papers/Report.PDF"])
      expect(selectEntityLocatorRenderer({ kind: "repository-path", value }, "binary"), value).toBe("pdf");
    expect(selectEntityLocatorRenderer({ kind: "repository-path", value: "archives/bundle.zip" }, "binary")).toBe(
      "opaque",
    );
    expect(isPdfDocument("a.pdf")).toBe(true);
    expect(isPdfDocument("a.md")).toBe(false);
  });

  it("lets the read outcome decide directory versus file, never the shape of the name", () => {
    // 名字里带点的目录仍是目录;读面说 directory 就是 directory。
    for (const value of ["harness/research", "harness/research/", "docs/adr/", "releases/v1.2"])
      expect(selectEntityLocatorRenderer({ kind: "repository-path", value }, "directory"), value).toBe("directory");
    // 反过来:没有扩展名的**文件**不再被当成目录树,它只是没有渲染器的文件。
    expect(selectEntityLocatorRenderer({ kind: "repository-path", value: "bin/harness" }, "file")).toBe("opaque");
  });

  it("does not render what the read surface could not deliver", () => {
    for (const outcome of ["missing", "too-large", "unsupported"] as const)
      expect(selectEntityLocatorRenderer({ kind: "repository-path", value: "docs/x.md" }, outcome), outcome).toBe(
        "opaque",
      );
  });

  it("does not pretend to render what it cannot", () => {
    // 压缩包与图片:元数据卡,不是 Markdown。
    for (const value of ["archives/bundle.zip", "images/shot.png", "data/rows.csv"])
      expect(selectEntityLocatorRenderer({ kind: "repository-path", value }, "file"), value).toBe("opaque");
  });

  it("treats non repository-path locators as opaque regardless of their extension", () => {
    // url 指针即使以 .md 结尾也不是仓内文件——渲染器表按 locator kind 先判,不看后缀。
    expect(selectEntityLocatorRenderer({ kind: "url", value: "https://example.com/spec.md" }, "file")).toBe("opaque");
    expect(selectEntityLocatorRenderer({ kind: "external-key", value: "JIRA-1234" }, "file")).toBe("opaque");
  });

  it("exposes the extension predicates the table is built from", () => {
    expect(isHtmlDocument("a.html")).toBe(true);
    expect(isHtmlDocument("a.md")).toBe(false);
    expect(isMarkdownDocument("a.md")).toBe(true);
    expect(isMarkdownDocument("a.html")).toBe(false);
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

describe("url derived title", () => {
  it("takes the last path segment, then the host — the daemon url resolver rule", () => {
    expect(titleOfUrlLocator("http://127.0.0.1:9/issues/2224")).toBe("2224");
    expect(titleOfUrlLocator("https://example.com/")).toBe("example.com");
    expect(titleOfUrlLocator("not a url")).toBe("not a url");
  });
});
