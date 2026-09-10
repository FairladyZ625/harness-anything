import type { EntityAttributeDraft, EntityAttributeField } from "../../entity-attribute-form.ts";

/**
 * 一版属性声明长出来的那几个输入控件。
 *
 * 控件形态只由**声明**决定:给了取值清单就是下拉,布尔是复选框,数字是数字框——没有任何
 * 按 kind 名字写死的分支,新声明一个种类不必回来改这里。新建向导与既有实例的编辑面共用
 * 这一份:两处各画一套,同一个属性就会在「填」和「改」时长得不一样。
 */
export function EntityAttributeFields({
  fields,
  draft,
  issues,
  testIdPrefix,
  onChange,
}: {
  readonly fields: readonly EntityAttributeField[];
  readonly draft: EntityAttributeDraft;
  readonly issues: Readonly<Record<string, string>>;
  /** 定位前缀:同一张表在两个面上各有自己的 testid 命名空间。 */
  readonly testIdPrefix: string;
  readonly onChange: (name: string, value: string) => void;
}) {
  return (
    <>
      {fields.map((field) => (
        <AttributeInput
          key={field.name}
          field={field}
          testId={`${testIdPrefix}-${field.name}`}
          value={draft[field.name] ?? ""}
          issue={issues[field.name] ?? null}
          onChange={(value) => onChange(field.name, value)}
        />
      ))}
    </>
  );
}

function AttributeInput({
  field,
  testId,
  value,
  issue,
  onChange,
}: {
  readonly field: EntityAttributeField;
  readonly testId: string;
  readonly value: string;
  readonly issue: string | null;
  readonly onChange: (value: string) => void;
}) {
  const label = (
    <span className="flex items-baseline gap-2">
      <span className="font-mono">{field.name}</span>
      <span className={field.required ? "ui-micro text-accent" : "ui-micro text-text-faint"}>
        {field.required ? "必填" : "可选"}
      </span>
    </span>
  );
  if (field.type === "boolean")
    return (
      <label className="flex items-center gap-2 ui-meta text-text-muted" data-testid={testId}>
        <input
          type="checkbox"
          aria-label={field.name}
          checked={value === "true"}
          onChange={(event) => onChange(event.target.checked ? "true" : "false")}
        />
        {label}
      </label>
    );
  return (
    <label className="flex flex-col gap-1 ui-meta text-text-muted" data-testid={testId}>
      {label}
      {field.options !== null ? (
        <select
          aria-label={field.name}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="rounded border border-border bg-surface px-2 py-1 ui-meta text-text"
        >
          <option value="">未选择</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          aria-label={field.name}
          type={field.type === "string" ? "text" : "number"}
          {...(field.type === "integer" ? { step: 1 } : {})}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="rounded border border-border bg-surface px-2 py-1 ui-meta text-text"
        />
      )}
      {issue !== null && value.trim() !== "" && <span className="ui-micro text-status-blocked">{issue}</span>}
    </label>
  );
}
