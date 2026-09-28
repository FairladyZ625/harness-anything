// harness-test-tier: contract
// 设置表单字段与说明都从 kernel Settings 声明投影到动作契约,再经 daemon catalog
// 到达 GUI；这里锁定 GUI 行不会另建字段或文案登记表。
import { describe, expect, it } from "vitest";
import { settingsUpdateInputFields } from "@harness-anything/kernel";
import { settingsFormRows } from "../src/renderer/settings-form.ts";

// 与 daemon gui-catalog.settingsFields 同一映射:断言的派生面因此是真实契约,不是测试里再抄一份。
const descriptors = settingsUpdateInputFields.map(({ field, description, type, required, enum: values }) => ({
  field,
  description,
  type,
  required,
  ...(values ? { enum: [...values] } : {}),
}));

describe("Settings 字段声明投影覆盖 GUI", () => {
  const rows = settingsFormRows(descriptors);

  it("渲染中的每个持久设置字段都携带声明表说明", () => {
    const missing = rows.filter((row) => !row.description).map((row) => row.field);
    expect(missing, `契约渲染字段缺声明说明: ${missing.join(", ")}`).toEqual([]);
  });

  it("agenda.pinLimit 从声明表自动成为 number 行", () => {
    expect(rows.find((row) => row.field === "agendaPinLimit")).toMatchObject({ widget: "number" });
  });
});
