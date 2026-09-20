// harness-test-tier: contract
// 设置表单文案面的契约锁:字段面是自动派生的(kernel settingsUpdateInputFields 单源,
// daemon gui-catalog 与动作目录同一映射),文案面是 FIELD_COPY 手工登记——两侧没有
// 机制对齐时必然漂移,漂移形态就是界面上出现裸 camelCase 字段名(实证:gatesFromDocument,
// PR #2814 加入契约后未登记)。本测试把登记面锁死到同一单源:settingsFormRows
// (契约→渲染行的真实派生,天然容纳 EXCLUDED_FIELDS 与不可渲染类型的合法豁免)的
// 每一行都必须有文案。双向:缺登记=红(新字段裸奔),多登记=红(死文案误导下一个登记人)。
import { describe, expect, it } from "vitest";
import { settingsUpdateInputFields } from "@harness-anything/kernel";
import { settingsFormRows } from "../src/renderer/settings-form.ts";
import { FIELD_COPY } from "../src/renderer/views/settings/RepositorySettingsPanel.tsx";

// 与 daemon gui-catalog.settingsFields 同一映射:断言的派生面因此是真实契约,不是测试里再抄一份。
const descriptors = settingsUpdateInputFields.map(({ field, type, required, enum: values }) => ({
  field,
  type,
  required,
  ...(values ? { enum: [...values] } : {}),
}));

describe("Settings 字段文案登记覆盖契约", () => {
  const renderedFields = settingsFormRows(descriptors).map((row) => row.field);

  it("渲染中的每个契约字段都有登记文案,不允许裸 camelCase 进界面", () => {
    const missing = renderedFields.filter((field) => !FIELD_COPY[field]);
    expect(missing, `契约渲染字段缺文案登记: ${missing.join(", ")}`).toEqual([]);
  });

  it("登记表没有已不渲染的死键(字段删除/改名后文案必须跟着退场)", () => {
    const stale = Object.keys(FIELD_COPY).filter((field) => !renderedFields.includes(field));
    expect(stale, `FIELD_COPY 登记了不渲染的字段: ${stale.join(", ")}`).toEqual([]);
  });
});
