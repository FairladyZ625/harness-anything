import { useState } from "react";
import type { ArtifactKindDeclaration } from "../../vertical-kind-client.ts";
import { consumeKnownError } from "../../../api/error-consumption.ts";
import { locateJsonError } from "./VerticalKindForm.tsx";

const ATTRIBUTE_TYPES = ["string", "number", "integer", "boolean"] as const;

/**
 * 发布下一个不可变属性版本(vN → vN+1)。已发布版本的正文只读展示——它不再可改,
 * 改属性就是再发一个版本;已固定的实例继续按它接受的版本读取。
 *
 * 属性声明用 JSON 编辑器(与 kind 表单的 relations 编辑器同一交互):键是属性名,
 * 值是 { type, enum?, required? };结构判据镜像 kernel 的 EntityAttributeDeclaration,
 * 错误定位到键名。
 */
export function VerticalKindSchemaForm({
  current,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  /** 当前接受的完整声明:最新已发布版本从它的 schemaVersions 取。 */
  readonly current: ArtifactKindDeclaration;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSubmit: (attributes: Readonly<Record<string, unknown>>) => void;
}) {
  const published = [...(current.schemaVersions ?? [])].sort((left, right) => left.version - right.version);
  const latest = published.at(-1) ?? { version: 1, attributes: {} as unknown };
  const next = latest.version + 1;
  const [attributes, setAttributes] = useState("{}");
  const issue = describeAttributesIssue(attributes);
  const valid = !busy && issue === null;
  return (
    <form
      data-testid="vertical-kind-schema-form"
      className="mt-3 flex flex-col gap-3 rounded-md border border-border bg-surface-raised p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        try {
          onSubmit(JSON.parse(attributes) as Record<string, unknown>);
        } catch (cause) {
          consumeKnownError(cause);
        }
      }}
    >
      <section className="flex flex-col gap-1">
        <h3 className="ui-meta font-semibold uppercase tracking-wide text-text-muted">已发布版本(只读,不可改写)</h3>
        <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-3 gap-y-1">
          {published.map((version) => (
            <div key={version.version} className="contents">
              <dt className="font-mono ui-micro text-text-faint">v{version.version}</dt>
              <dd className="break-all font-mono ui-meta text-text">{JSON.stringify(version.attributes)}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="flex flex-col gap-1">
        <h3 className="ui-meta font-semibold uppercase tracking-wide text-text-muted">发布 v{next}</h3>
        <p className="ui-micro leading-relaxed text-text-faint">
          声明这个版本的属性:每个条目是 {"<属性名>: { type, enum?, required? }"},type 为 string / number / integer /
          boolean。发布后不可改写;已入库的实例继续按它创建时 固定的版本读取,新实例默认用最新版本。空对象 {"{}"}{" "}
          表示这一版没有额外属性。
        </p>
        <textarea
          aria-label="attributes JSON"
          value={attributes}
          onChange={(event) => setAttributes(event.target.value)}
          rows={6}
          spellCheck={false}
          className="rounded border border-border bg-surface p-2 font-mono ui-micro text-text"
        />
        {issue !== null && (
          <p data-testid="vertical-kind-schema-issue" className="ui-micro text-status-blocked">
            {issue}
          </p>
        )}
      </section>
      {error !== null && <p className="ui-meta text-status-blocked">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={!valid}>
          发布 v{next}
        </button>
        <button type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

/**
 * attributes 文本的校验:先 JSON 解析(错误定位到行列),再逐条目对照 kernel 的
 * EntityAttributeDeclaration(键名形状、type 词表、enum 非空、无未声明字段)。
 * 真正的裁决在 daemon 写路上,这里是让错误在提交前就能被看见。
 */
export function describeAttributesIssue(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    consumeKnownError(cause);
    return cause instanceof Error ? `JSON 解析失败:${locateJsonError(cause.message, text)}` : "JSON 解析失败。";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return "attributes 必须是 JSON 对象(属性名 → 声明)。";
  for (const [name, declaration] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[a-z][A-Za-z0-9]*$/u.test(name)) return `属性 ${name}:名称须以小写字母开头,后接字母/数字。`;
    if (typeof declaration !== "object" || declaration === null || Array.isArray(declaration))
      return `属性 ${name}:声明必须是对象。`;
    const record = declaration as Record<string, unknown>;
    if (typeof record.type !== "string" || !(ATTRIBUTE_TYPES as readonly string[]).includes(record.type))
      return `属性 ${name}:type 只能是 ${ATTRIBUTE_TYPES.join(" / ")}。`;
    if (record.required !== undefined && typeof record.required !== "boolean")
      return `属性 ${name}:required 只能是 true 或 false。`;
    if (record.enum !== undefined) {
      if (
        !Array.isArray(record.enum) ||
        record.enum.length === 0 ||
        record.enum.some((value) => typeof value !== "string" || !value.trim())
      )
        return `属性 ${name}:enum 必须是非空字符串数组。`;
    }
    const unknown = Object.keys(record).filter((key) => key !== "type" && key !== "required" && key !== "enum");
    if (unknown.length > 0) return `属性 ${name}:未声明字段 ${unknown.join(", ")}。`;
  }
  return null;
}
