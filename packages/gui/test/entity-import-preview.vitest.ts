// harness-test-tier: fast
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deriveEntityId,
  directoryHasReadme,
  firstMarkdownHeading,
  sourceIdentityOf,
  titleOfDirectoryLocator,
  titleOfFileLocator,
} from "../src/renderer/entity-import-preview.ts";

/**
 * 预览推导的判据(task_a494eac2 Goal 1)。id 公式必须与 kernel `deriveArtifactEntityId`
 * 逐字节一致——这里用 node:crypto 独立算一遍作对照,防 WebCrypto 路径自己漂了;
 * title 规则镜像 daemon `resolveArtifactSource` 的 README/首标题/文件名三档。
 */

function kernelStyleId(repoId: string, idPrefix: string, path: string): string {
  const digest = createHash("sha256").update(sourceIdentityOf(repoId, path)).digest("hex").slice(0, 16);
  return `${idPrefix}-${digest}`;
}

describe("derived entity id", () => {
  it("matches the kernel formula byte for byte via an independent sha256", async () => {
    for (const [repoId, prefix, path] of [
      ["harness-anything", "RSRCH", "harness/context/research/2026-09-05-coordination-coherence-product"],
      ["repo-entities", "ADR", "docs/adr/ADR-0001.md"],
    ] as const) {
      const expected = kernelStyleId(repoId, prefix, path);
      await expect(deriveEntityId(repoId, prefix, path), `${repoId}:${path}`).resolves.toBe(expected);
      expect(expected).toMatch(/^[A-Z][A-Z0-9]{0,15}-[0-9a-f]{16}$/u);
    }
  });

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
