/**
 * settings 动作契约字段表(daemon catalog snapshot 的 settingsFields)→ GUI 仓库设置表单的行描述。
 *
 * 字段清单不手写:行集合、控件类型、枚举取值面全部由契约派生,kernel 加字段自动出现在表单。
 * 这与 entity-attribute-form 同型:判定与渲染分开,判定才是测得动的纯模块。
 *
 * 目录驱动的选择器(vertical/preset/profile/scaffold)是契约之外的 GUI 特有联动,标成
 * catalog-select 由视图注入目录选项与级联;排除项是「本表单不渲染哪些字段」的 UI 裁决,
 * 不是字段清单的复制品——locale 归语言 tab 即时提交,expectedVersion/idempotencyKey 由
 * mutation 层机械填充。认不出的字段类型不进表单:摆一个猜出来的控件,人填的值会在中心被拒,
 * 那比不摆更糟。
 */

/** 契约字段描述,形状对齐 daemon catalog snapshot 的 settingsFields 行。 */
export interface SettingsFieldDescriptor {
  readonly field: string;
  readonly type: string;
  readonly required: boolean;
  readonly enum?: readonly string[];
}

export type SettingsFieldValue = string | number | boolean | readonly string[];

/** 表单草稿:扁平 action 值,键 = 契约字段名,来源 daemon settings read 的 values。 */
export type SettingsDraft = Readonly<Record<string, SettingsFieldValue | undefined>>;

export type SettingsFieldWidget = "enum-select" | "catalog-select" | "toggle" | "number" | "text" | "string-array";

export interface SettingsFieldRow {
  readonly field: string;
  readonly widget: SettingsFieldWidget;
  /** enum-select 的取值面;其余 widget 为 null。 */
  readonly options: readonly string[] | null;
}

/** 目录选项注入的字段:vertical→preset→profile 级联与 scaffold 选择器。 */
export const CATALOG_SELECT_FIELDS: ReadonlySet<string> = new Set([
  "defaultVertical",
  "defaultPreset",
  "defaultProfile",
  "taskScaffold",
  "repositoryScaffold",
]);

const EXCLUDED_FIELDS: ReadonlySet<string> = new Set(["locale", "expectedVersion", "idempotencyKey"]);

export function settingsFormRows(fields: readonly SettingsFieldDescriptor[]): readonly SettingsFieldRow[] {
  return fields.flatMap((descriptor): SettingsFieldRow[] => {
    if (EXCLUDED_FIELDS.has(descriptor.field)) return [];
    if (CATALOG_SELECT_FIELDS.has(descriptor.field) && descriptor.type === "string")
      return [{ field: descriptor.field, widget: "catalog-select", options: null }];
    if (descriptor.enum && descriptor.type === "string")
      return [{ field: descriptor.field, widget: "enum-select", options: [...descriptor.enum] }];
    switch (descriptor.type) {
      case "boolean":
        return [{ field: descriptor.field, widget: "toggle", options: null }];
      case "number":
        return [{ field: descriptor.field, widget: "number", options: null }];
      case "string-array":
        return [{ field: descriptor.field, widget: "string-array", options: null }];
      case "string":
        return [{ field: descriptor.field, widget: "text", options: null }];
      default:
        return [];
    }
  });
}

/** 提交 payload:表单里已有值的字段全量带回;等值字段在中心走 no-changes,无需差分。 */
export function settingsPayloadFromDraft(
  draft: SettingsDraft,
  fields: readonly SettingsFieldDescriptor[],
): Readonly<Record<string, SettingsFieldValue>> {
  return Object.fromEntries(
    settingsFormRows(fields).flatMap((row) => {
      const value = draft[row.field];
      return value === undefined ? [] : [[row.field, value]];
    }),
  );
}

/** string-array 的编辑形态:逗号/空白分隔的文本,空段丢弃。 */
export function parseStringArrayInput(text: string): readonly string[] {
  return text
    .split(/[\s,]+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function formatStringArrayInput(value: SettingsFieldValue | undefined): string {
  return Array.isArray(value) ? value.join(", ") : "";
}
