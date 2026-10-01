// harness-test-tier: contract
// 设置表单字段与说明都从 kernel Settings 声明投影到动作契约,再经 daemon catalog
// 到达 GUI；这里锁定两件事:GUI 行不会另建字段或文案登记表,以及每个渲染中的字段
// 在两个 locale 都有「名称 + 它管什么 + 改了会怎样」三件文案、每个分组有组名与
// 组说明、每个枚举取值有人话解释——缺一项当场红,不裸露字段名或枚举原值
// (自描述 chokepoint:task_f5723d879ed2f91ca727d5714d 的分组版)。另锁两条文案纪律:
// 英文的「它管什么 / 改了会怎样」与 `ha settings update --help` 逐字同源;中文文案用全角标点。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SETTINGS_FIELD_GROUPS,
  SETTINGS_FIELD_PRESENTATION,
  settingsUpdateInputFields,
} from "@harness-anything/kernel";
import { settingsFormRows } from "../src/renderer/settings-form.ts";
import { settingsFieldsFace, settingsGroupsFace } from "./settings-catalog-snapshot.ts";

// 与 daemon gui-catalog.settingsFields 同一映射:断言的派生面因此是真实契约,不是测试里再抄一份。
const descriptors = settingsFieldsFace();

function catalog(locale: "en-US" | "zh-CN"): Record<string, string> {
  return JSON.parse(
    readFileSync(new URL(`../src/renderer/i18n/locales/${locale}/views.json`, import.meta.url), "utf8"),
  );
}

const en = catalog("en-US"),
  zh = catalog("zh-CN");

describe("Settings 字段声明投影覆盖 GUI", () => {
  const rows = settingsFormRows(descriptors);

  it("渲染中的每个持久设置字段都携带声明表说明", () => {
    const missing = rows.filter((row) => !row.description).map((row) => row.field);
    expect(missing, `契约渲染字段缺声明说明: ${missing.join(", ")}`).toEqual([]);
  });

  it("agenda.pinLimit 从声明表自动成为 number 行", () => {
    expect(rows.find((row) => row.field === "agendaPinLimit")).toMatchObject({ widget: "number" });
  });

  it("任务 WIP 与 root 阈值从声明表自动成为 number 行", () => {
    expect(rows.find((row) => row.field === "wipLimit")).toMatchObject({ widget: "number" });
    expect(rows.find((row) => row.field === "rootThreshold")).toMatchObject({ widget: "number" });
  });
});

describe("Settings 自描述文案 chokepoint(两个 locale 都要有,缺一项即红)", () => {
  const rows = settingsFormRows(descriptors);

  /** 渲染字段面 = 契约仓库字段(排除 locale/机械项/一次性命令,与面板 EXCLUDED_FIELDS 同源)。 */
  it("契约里的持久设置字段全部进入渲染面", () => {
    const renderedFields = new Set(rows.map(({ field }) => field)),
      excluded = new Set(["locale", "expectedVersion", "idempotencyKey", "gatesFromDocument", "gatesDraft"]);
    for (const { field } of settingsUpdateInputFields)
      if (!excluded.has(field)) expect(renderedFields.has(field), `${field} 应在渲染字段面里`).toBe(true);
  });

  it.each(["en-US", "zh-CN"] as const)("每个渲染字段都有名称、说明与「改了会怎样」(%s)", (locale) => {
    const messages = locale === "en-US" ? en : zh,
      missing: string[] = [];
    for (const { field } of rows)
      for (const suffix of ["Label", "Description", "Effect"] as const)
        if (!messages[`views.settingsView.${field}${suffix}`]) missing.push(`${field}${suffix}`);
    expect(missing, `${locale} 缺文案: ${missing.join(", ")}`).toEqual([]);
  });

  it.each(["en-US", "zh-CN"] as const)("每个有渲染字段的分组都有组名与组说明 (%s)", (locale) => {
    const messages = locale === "en-US" ? en : zh,
      groups = settingsGroupsFace().filter((group) => rows.some((row) => row.group === group.id)),
      missing: string[] = [];
    for (const { id } of groups)
      for (const suffix of ["label", "description"] as const)
        if (!messages[`views.settingsView.settingsGroup.${id}.${suffix}`])
          missing.push(`settingsGroup.${id}.${suffix}`);
    // presentation 组只承载 locale(GUI 归语言页签),不要求出现在仓库设置页文案里。
    expect(
      missing.filter((entry) => !entry.startsWith("settingsGroup.presentation.")),
      `${locale} 缺分组文案: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it.each(["en-US", "zh-CN"] as const)("枚举选择器的每个取值都有旁注人话 (%s)", (locale) => {
    const messages = locale === "en-US" ? en : zh,
      enumRows = rows.filter((row) => row.widget === "enum-select"),
      missing: string[] = [];
    for (const row of enumRows)
      for (const value of row.options ?? [])
        if (!messages[`views.settingsView.enum.${row.field}.${value}`]) missing.push(`enum.${row.field}.${value}`);
    expect(missing, `${locale} 缺枚举旁注: ${missing.join(", ")}`).toEqual([]);
  });

  it("每个渲染字段:设置页英文说明与 `ha settings update --help` 是同一份解释", () => {
    // CLI 帮助渲染的就是声明源的 description 与 effect;设置页英文文案与它逐字相同,
    // 改说明只有声明源一个入口,两处不会各说各话。
    const drifted: string[] = [];
    for (const row of rows) {
      if (en[`views.settingsView.${row.field}Description`] !== row.description) drifted.push(`${row.field}Description`);
      if (en[`views.settingsView.${row.field}Effect`] !== row.effect) drifted.push(`${row.field}Effect`);
    }
    expect(drifted, `英文设置文案与声明源不一致: ${drifted.join(", ")}`).toEqual([]);
  });

  it("定时任务补跑时限归「定时任务」组", () => {
    expect(rows.find(({ field }) => field === "scheduleAdmissionWindowMs")).toMatchObject({
      widget: "number",
      group: "schedules-nodes",
    });
    expect(zh["views.settingsView.settingsGroup.schedules-nodes.label"]).toBe("定时任务");
  });

  it("中文设置文案用全角标点:半角逗号、句号、冒号、分号、括号不与中文相邻", () => {
    const cjk = "[\\u4e00-\\u9fff]",
      halfWidth = new RegExp(`[,.;:!?()]${cjk}|${cjk}[,;:!?()]|${cjk}\\.(?!\\w)`, "u"),
      offenders = Object.entries(zh)
        .filter(([key, value]) => key.startsWith("views.settingsView.") && halfWidth.test(value))
        .map(([key]) => key.slice("views.settingsView.".length));
    expect(offenders, `中文设置文案里有半角标点: ${offenders.join(", ")}`).toEqual([]);
  });

  it("分组面与呈现元数据都从 kernel 单源投影(不另建登记表)", () => {
    // 每个渲染字段都能在声明源的呈现元数据里找到组;分组清单的 id 集与声明源一致。
    const presentation = new Map(SETTINGS_FIELD_PRESENTATION.map((row) => [row.field, row.group]));
    for (const { field } of rows) expect(presentation.get(field), `${field} 缺呈现分组`).toBeTruthy();
    expect(settingsGroupsFace().map(({ id }) => id)).toEqual(SETTINGS_FIELD_GROUPS.map(({ id }) => id));
  });
});
