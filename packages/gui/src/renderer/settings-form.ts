/**
 * settings 动作契约字段表(daemon catalog snapshot 的 settingsFields)→ GUI 仓库设置表单的行描述。
 *
 * 字段清单不手写:行集合、控件类型、枚举取值面全部由契约派生,kernel 加字段自动出现
 * 在表单。分组与逐项解释同样从契约投影(group/effect/defaultValue),不在这里另写一份
 * 分组表。这与 entity-attribute-form 同型:判定与渲染分开,判定才是测得动的纯模块。
 *
 * 目录驱动的选择器(vertical/preset/profile/scaffold/reviewer/workflows)是契约之外的 GUI 特有
 * 联动,标成 catalog-select / catalog-multi-select 由视图注入目录选项与级联;排除项是「本表单
 * 不渲染哪些字段」的 UI 裁决,不是字段清单的复制品——locale 归语言 tab 即时提交,
 * expectedVersion/idempotencyKey 由 mutation 层机械填充。认不出的字段类型不进表单:摆一个
 * 猜出来的控件,人填的值会在中心被拒,那比不摆更糟。
 */

import type { GateMappingDraft } from "./gate-mapping-form.ts";

/** 契约字段描述,形状对齐 daemon catalog snapshot 的 settingsFields 行。 */
export interface SettingsFieldDescriptor {
  readonly field: string;
  readonly description?: string;
  readonly type: string;
  readonly required: boolean;
  readonly enum?: readonly string[];
  readonly group?: string;
  readonly effect?: string;
  readonly defaultValue?: string | number | boolean | readonly string[];
}

/** 有序分组描述,形状对齐 daemon catalog snapshot 的 settingsGroups 行。 */
export interface SettingsGroupDescriptor {
  readonly id: string;
  readonly advanced?: boolean;
}

export type RolePreferences = Readonly<
  Partial<Record<"defaultWorker" | "defaultCommander" | "defaultReviewer", string | null>>
>;
export type SettingsFieldValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly GateMappingDraft[]
  | RolePreferences;

/** 表单草稿:扁平 action 值,键 = 契约字段名,来源 daemon settings read 的 values。 */
export type SettingsDraft = Readonly<Record<string, SettingsFieldValue | undefined>>;

export type SettingsFieldWidget =
  | "role-selectors"
  | "enum-select"
  | "catalog-select"
  | "catalog-multi-select"
  | "string-list"
  | "toggle"
  | "number"
  | "text";

export interface SettingsFieldRow {
  readonly field: string;
  readonly description: string | null;
  readonly widget: SettingsFieldWidget;
  /** enum-select 的取值面;其余 widget 为 null。 */
  readonly options: readonly string[] | null;
  /** 呈现分组 id(kernel 声明源投影);契约未给组的字段不进分组渲染。 */
  readonly group: string | null;
  /** 「改了会怎样」一句话(kernel 声明源投影的英文,本地文案在 locales)。 */
  readonly effect: string | null;
  /** 声明默认值;可选字段(默认未设置)为 undefined。 */
  readonly defaultValue: SettingsFieldValue | undefined;
}

/** 分组后的表单行:顺序 = 目录快照的 settingsGroups 顺序,组内保持契约字段顺序。 */
export interface SettingsGroupedRow {
  readonly id: string;
  readonly advanced: boolean;
  readonly rows: readonly SettingsFieldRow[];
}

/** 目录单选的字段:vertical→preset→profile 级联、两个 scaffold,以及验收人
 * (取值面 = bundled 层 ∪ 已安装 agent,由视图注入)。 */
export const CATALOG_SELECT_FIELDS: ReadonlySet<string> = new Set([
  "defaultVertical",
  "defaultPreset",
  "defaultProfile",
  "taskScaffold",
  "repositoryScaffold",
]);

/** 目录多选的字段:CI 工作流(取值面 = .github/workflows 的 *.yml 基名,空集合合法)。 */
export const CATALOG_MULTI_SELECT_FIELDS: ReadonlySet<string> = new Set(["ciWorkflows"]);

// gatesFromDocument 是一次性导入命令(经 ingress 从 authored harness.yaml 铸造 gates),
// 不是持久设置——settings read 的 values 永远没有它,渲染成开关会永远显示"关"。它归
// 门映射编辑区的导入按钮,不进字段行。gatesDraft(json-object-array)认不出类型,自然豁免。
const EXCLUDED_FIELDS: ReadonlySet<string> = new Set([
  "locale",
  "expectedVersion",
  "idempotencyKey",
  "gatesFromDocument",
]);

function settingsFieldRow(
  descriptor: SettingsFieldDescriptor,
  widget: SettingsFieldWidget,
  options: readonly string[] | null,
): SettingsFieldRow {
  return {
    field: descriptor.field,
    description: descriptor.description ?? null,
    widget,
    options,
    group: descriptor.group ?? null,
    effect: descriptor.effect ?? null,
    defaultValue: descriptor.defaultValue,
  };
}

export function settingsFormRows(fields: readonly SettingsFieldDescriptor[]): readonly SettingsFieldRow[] {
  return fields.flatMap((descriptor): SettingsFieldRow[] => {
    if (EXCLUDED_FIELDS.has(descriptor.field)) return [];
    if (descriptor.field === "roles" && descriptor.type === "json-object")
      return [settingsFieldRow(descriptor, "role-selectors", null)];
    if (CATALOG_SELECT_FIELDS.has(descriptor.field) && descriptor.type === "string")
      return [settingsFieldRow(descriptor, "catalog-select", null)];
    if (CATALOG_MULTI_SELECT_FIELDS.has(descriptor.field) && descriptor.type === "string-array")
      return [settingsFieldRow(descriptor, "catalog-multi-select", null)];
    if (descriptor.enum && descriptor.type === "string")
      return [settingsFieldRow(descriptor, "enum-select", [...descriptor.enum])];
    switch (descriptor.type) {
      case "boolean":
        return [settingsFieldRow(descriptor, "toggle", null)];
      case "number":
        return [settingsFieldRow(descriptor, "number", null)];
      case "string":
        return [settingsFieldRow(descriptor, "text", null)];
      case "string-array":
        return [settingsFieldRow(descriptor, "string-list", null)];
      default:
        return [];
    }
  });
}

/** 按目录快照的组序装箱;没有组的行进尾部的无标题组(正常不可达——契约字段都带组)。 */
export function settingsGroupedRows(
  fields: readonly SettingsFieldDescriptor[],
  groups: readonly SettingsGroupDescriptor[],
): readonly SettingsGroupedRow[] {
  const rows = settingsFormRows(fields),
    grouped = groups.map((group) => ({
      id: group.id,
      advanced: group.advanced === true,
      rows: rows.filter((row) => row.group === group.id),
    })),
    ungrouped = rows.filter((row) => row.group === null || !groups.some((group) => group.id === row.group));
  return [
    ...grouped.filter((group) => group.rows.length > 0),
    ...(ungrouped.length ? [{ id: "", advanced: false, rows: ungrouped }] : []),
  ];
}

/** 草稿值与默认值的相等判定:数组逐元素(顺序有意义),其余严格相等。 */
export function settingsValueEquals(
  left: SettingsFieldValue | undefined,
  right: SettingsFieldValue | undefined,
): boolean {
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((entry, index) => entry === right[index]);
  return left === right;
}

/** 提交 payload:表单里已有值的字段全量带回;等值字段在中心走 no-changes,无需差分。 */
export function settingsPayloadFromDraft(
  draft: SettingsDraft,
  fields: readonly SettingsFieldDescriptor[],
  baseline: SettingsDraft = {},
): Readonly<Record<string, SettingsFieldValue>> {
  return Object.fromEntries(
    settingsFormRows(fields).flatMap((row): [string, SettingsFieldValue][] => {
      const value = draft[row.field];
      if (row.field === "roles") {
        const roles = (value ?? {}) as RolePreferences,
          previous = (baseline.roles ?? {}) as RolePreferences,
          delta = Object.fromEntries(
            Object.entries(roles).filter(([key, entry]) => entry !== previous[key as keyof RolePreferences]),
          );
        return Object.keys(delta).length ? [["roles", delta]] : [];
      }
      return value === undefined ? [] : [[row.field, value]];
    }),
  );
}
