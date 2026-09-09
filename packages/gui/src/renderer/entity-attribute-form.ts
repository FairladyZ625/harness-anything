/**
 * 一个 kind 的某一版属性声明 → 一张通用表单的字段表(E5 属性录入)。
 *
 * 属性是**纯值**:kernel 的 `EntityAttributeDeclaration` 只允许 string / number / integer /
 * boolean 与一个可选的取值清单,声明里没有渲染器、命令或写路可言。所以这里不需要按 kind
 * 分支——Research 和 ADR 与任何一个当场声明出来的 kind 走同一段代码,新声明一个 kind 不必
 * 改 GUI。
 *
 * 表单只按**实例被钉住的那一版**声明生成:新建实例钉 kind 最新已发布的版本,发布 v2 之后
 * 新建的实例按 v2 填,已存在的实例仍按它当初钉的版本。版本身份由中心给,这里不推断。
 *
 * 纯模块:不 import React,也不碰 window——判定与渲染分开,判定才测得动。
 */
export type EntityAttributeType = "string" | "number" | "integer" | "boolean";

export interface EntityAttributeField {
  readonly name: string;
  readonly type: EntityAttributeType;
  /** 声明给出的取值清单;没有声明时为 null(自由输入)。 */
  readonly options: readonly string[] | null;
  readonly required: boolean;
}

/** 表单的草稿态:每个属性一个字符串,boolean 用 "true"/"false"。空串 = 还没填。 */
export type EntityAttributeDraft = Readonly<Record<string, string>>;

export interface EntityAttributeReading {
  /** 通过判定、且调用者确实填了的属性值,类型已按声明还原(整数是 number,不是 "2026")。 */
  readonly values: Readonly<Record<string, unknown>>;
  /** 属性名 → 这一格的问题;非空时不该提交。 */
  readonly issues: Readonly<Record<string, string>>;
}

const TYPES: readonly EntityAttributeType[] = ["string", "number", "integer", "boolean"];

/**
 * 声明 → 字段表。认不出来的声明**不进表**:摆一个猜出来的控件,人填进去的值会在中心被拒,
 * 那比不摆更糟。声明顺序就是呈现顺序,不按必填重排——顺序是声明作者写下的那个。
 */
export function entityAttributeFields(attributes: unknown): readonly EntityAttributeField[] {
  if (typeof attributes !== "object" || attributes === null || Array.isArray(attributes)) return [];
  const fields: EntityAttributeField[] = [];
  for (const [name, declared] of Object.entries(attributes as Record<string, unknown>)) {
    if (typeof declared !== "object" || declared === null || Array.isArray(declared)) continue;
    const declaration = declared as { readonly type?: unknown; readonly enum?: unknown; readonly required?: unknown };
    if (!TYPES.includes(declaration.type as EntityAttributeType)) continue;
    const options =
      Array.isArray(declaration.enum) && declaration.enum.every((option) => typeof option === "string")
        ? (declaration.enum as readonly string[])
        : null;
    fields.push({
      name,
      type: declaration.type as EntityAttributeType,
      options,
      required: declaration.required === true,
    });
  }
  return fields;
}

/** 空草稿:boolean 从 "false" 起(复选框天然有值),其余从空串起。 */
export function emptyAttributeDraft(fields: readonly EntityAttributeField[]): EntityAttributeDraft {
  return Object.fromEntries(fields.map((field) => [field.name, field.type === "boolean" ? "false" : ""]));
}

/**
 * 草稿 → 提交值。留空的可选属性**不出现在结果里**:声明没给它默认值,替调用者编一个
 * 空串就是在描述符里写下一个人没说过的事实。
 */
export function readAttributeDraft(
  fields: readonly EntityAttributeField[],
  draft: EntityAttributeDraft,
): EntityAttributeReading {
  const values: Record<string, unknown> = {};
  const issues: Record<string, string> = {};
  for (const field of fields) {
    const raw = (draft[field.name] ?? "").trim();
    if (field.type === "boolean") {
      values[field.name] = raw === "true";
      continue;
    }
    if (raw === "") {
      if (field.required) issues[field.name] = "必填。";
      continue;
    }
    if (field.options !== null && !field.options.includes(raw)) {
      issues[field.name] = `只能是:${field.options.join("、")}。`;
      continue;
    }
    if (field.type === "string") {
      values[field.name] = raw;
      continue;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      issues[field.name] = "必须是数字。";
      continue;
    }
    if (field.type === "integer" && !Number.isSafeInteger(parsed)) {
      issues[field.name] = "必须是整数。";
      continue;
    }
    values[field.name] = parsed;
  }
  return { values, issues };
}
