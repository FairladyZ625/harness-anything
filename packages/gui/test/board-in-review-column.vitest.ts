// harness-test-tier: integration
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { STATUS_META } from "../src/renderer/components/badges.tsx";
import { BOARD_COLUMNS } from "../src/renderer/model/types.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

// CLI 的状态词表里只有 in_review(daemon-protocol-vocabulary.ts),GUI 曾把它标成
// 「封存中(Finalizing)」——同一状态两个名字。这里钉住统一命名:看板列/徽章的
// in_review 标签必须与 CLI 状态词对齐,不得回退成 finalizing 措辞。STATUS_META
// 的 label 在模块加载时按当前 locale 求值,英文文案直接断言 catalog。
describe("board in_review column naming", () => {
  beforeAll(() => {
    setActiveLocale("zh-CN");
  });

  it("keeps the in_review board column and its label aligned with the CLI status word", () => {
    expect(BOARD_COLUMNS).toContain("in_review");
    expect(STATUS_META.in_review.label).toBe("评审中(In Review)");
    const enComponents = JSON.parse(
      readFileSync(new URL("../src/renderer/i18n/locales/en-US/components.json", import.meta.url), "utf8"),
    ) as Record<string, string>;
    expect(enComponents["components.badges.inReview"]).toBe("In Review");
  });
});
