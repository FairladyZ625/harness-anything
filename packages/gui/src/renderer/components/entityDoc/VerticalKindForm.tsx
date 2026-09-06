import { useState } from "react";
import type { ArtifactKindDeclaration } from "../../vertical-kind-client.ts";
import { consumeKnownError } from "../../../api/error-consumption.ts";

const PREFIX = /^[A-Z][A-Z0-9]{0,15}$/u;
const KIND_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SCHEMA_REF = /^schema:\/\/[A-Za-z0-9][A-Za-z0-9/_.@-]*$/u;
const LOCATOR_KINDS = ["repository-path", "url", "external-key"] as const;

/**
 * kind 声明表单(task_a494eac2 Goal 3 收敛)。
 *
 * 编辑时身份/存储字段(id、version、idPrefix、pathTemplate、descriptorSchemaRef、
 * locatorKinds)是**只读展示**——它们是类型的身份与存储位置,改它们等于换一个类型;
 * 可编辑的只有 display、maturityVocabulary 与 relations。新建时这些字段还不存在,
 * 以**模板**呈现(预填默认值 + 每字段一句说明),不再是让人盲填的空白表单。
 *
 * relations 用可折叠 JSON 编辑器:解析错误定位到行列,条目结构错误定位到下标。
 */
export function VerticalKindForm({
  initial,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  readonly initial?: ArtifactKindDeclaration;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSubmit: (value: ArtifactKindDeclaration) => void;
}) {
  const [id, setId] = useState(initial?.id ?? "");
  const [version, setVersion] = useState(String(initial?.version ?? 1));
  const [idPrefix, setIdPrefix] = useState(initial?.idPrefix ?? "");
  const [schemaRef, setSchemaRef] = useState(initial?.descriptorSchemaRef ?? "schema://artifact-descriptor");
  const [pathTemplate, setPathTemplate] = useState(initial?.store.pathTemplate ?? "entities/{id}.json");
  const [locatorKinds, setLocatorKinds] = useState<readonly string[]>(
    initial?.locatorKinds.length ? initial.locatorKinds : ["repository-path"],
  );
  const [singular, setSingular] = useState(initial?.display.singular ?? "");
  const [plural, setPlural] = useState(initial?.display.plural ?? "");
  const [maturity, setMaturity] = useState(initial?.maturityVocabulary?.join(", ") ?? "");
  const [relations, setRelations] = useState(JSON.stringify(initial?.relations ?? [], null, 2));
  const [relationsOpen, setRelationsOpen] = useState((initial?.relations?.length ?? 0) > 0);
  const editing = initial !== undefined;
  const prefixError = PREFIX.test(idPrefix) ? null : "1–16 位大写字母/数字,首位必须是字母。";
  const idError = KIND_ID.test(id) ? null : "小写字母开头,段间用连字符(如 architecture-decision-record)。";
  const schemaRefError = SCHEMA_REF.test(schemaRef) ? null : "须为 schema:// 前缀的引用。";
  const pathError = validPathTemplate(pathTemplate) ? null : "规范相对路径,恰好一个 {id}。";
  const locatorError = locatorKinds.length > 0 ? null : "至少选择一种 locator 类型。";
  const relationsIssue = describeRelationsIssue(relations);
  const valid =
    !busy &&
    (editing || (KIND_ID.test(id) && !prefixError && !schemaRefError && !pathError && !locatorError)) &&
    singular.trim().length > 0 &&
    plural.trim().length > 0 &&
    relationsIssue === null;
  return (
    <form
      data-testid="vertical-kind-form"
      className="mt-3 flex flex-col gap-3 rounded-md border border-border bg-surface-raised p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        try {
          // relationsIssue === null 已保证可解析且是数组;这里的 parse 只取值。
          const parsedRelations = JSON.parse(relations) as unknown[];
          onSubmit({
            id,
            entityType: "artifact",
            version: Number(version),
            idPrefix,
            display: { singular: singular.trim(), plural: plural.trim() },
            descriptorSchemaRef: schemaRef.trim(),
            store: { pathTemplate },
            locatorKinds: locatorKinds as ArtifactKindDeclaration["locatorKinds"],
            ...(maturity.trim() ? { maturityVocabulary: csv(maturity) } : {}),
            ...(parsedRelations.length ? { relations: parsedRelations } : {}),
          });
        } catch (cause) {
          consumeKnownError(cause);
        }
      }}
    >
      <section data-testid="vertical-kind-identity" className="flex flex-col gap-2">
        <h3 className="ui-meta font-semibold uppercase tracking-wide text-text-muted">
          身份与存储
          {editing ? "(只读——改它们是换一个类型,不是改一个字段)" : "(按模板预填,创建后不可改)"}
        </h3>
        {editing ? (
          <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-3 gap-y-1">
            {(
              [
                ["id", initial!.id],
                ["version", String(initial!.version)],
                ["idPrefix", initial!.idPrefix],
                ["descriptorSchemaRef", initial!.descriptorSchemaRef],
                ["store.pathTemplate", initial!.store.pathTemplate],
                ["locatorKinds", initial!.locatorKinds.join(", ")],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="font-mono ui-micro text-text-faint">{label}</dt>
                <dd className="break-all font-mono ui-meta text-text">{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Field label="id" value={id} onChange={setId} issue={idError} hint="类型身份,创建后不可改。" />
              <Field label="version" value={version} onChange={setVersion} type="number" hint="声明版本,从 1 开始。" />
              <Field
                label="idPrefix"
                value={idPrefix}
                onChange={setIdPrefix}
                issue={prefixError}
                hint="实体 id 前缀,如 ADR。"
              />
              <Field
                label="descriptorSchemaRef"
                value={schemaRef}
                onChange={setSchemaRef}
                issue={schemaRefError}
                hint="描述符 schema 引用,默认 artifact 通用描述符。"
              />
              <Field
                label="store.pathTemplate"
                value={pathTemplate}
                onChange={setPathTemplate}
                issue={pathError}
                hint="描述符落盘路径模板,必须恰好含一个 {id}。"
              />
            </div>
            <fieldset className="flex flex-col gap-1">
              <legend className="ui-meta text-text-muted">locatorKinds(至少一种)</legend>
              <div className="flex flex-wrap gap-3">
                {LOCATOR_KINDS.map((kind) => (
                  <label key={kind} className="inline-flex items-center gap-1 ui-meta text-text-muted">
                    <input
                      type="checkbox"
                      checked={locatorKinds.includes(kind)}
                      onChange={(event) =>
                        setLocatorKinds((previous) =>
                          event.target.checked ? [...previous, kind] : previous.filter((item) => item !== kind),
                        )
                      }
                    />
                    <span className="font-mono ui-micro">{kind}</span>
                  </label>
                ))}
              </div>
              {locatorError && <span className="ui-micro text-status-blocked">{locatorError}</span>}
            </fieldset>
          </>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="ui-meta font-semibold uppercase tracking-wide text-text-muted">呈现与词表(可编辑)</h3>
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="display.singular"
            value={singular}
            onChange={setSingular}
            hint="单数显示名,如 Architecture Decision Record。"
          />
          <Field label="display.plural" value={plural} onChange={setPlural} hint="复数显示名。" />
          <Field
            label="maturityVocabulary(逗号分隔)"
            value={maturity}
            onChange={setMaturity}
            hint="可选:这个 kind 实体的成熟度词表,如 draft, reviewed, accepted。"
          />
        </div>
      </section>

      <section data-testid="vertical-kind-relations" className="flex flex-col gap-1">
        <button
          type="button"
          aria-expanded={relationsOpen}
          onClick={() => setRelationsOpen((open) => !open)}
          className="flex items-center gap-2 text-left ui-meta font-semibold uppercase tracking-wide text-text-muted"
        >
          <span>{relationsOpen ? "▾" : "▸"}</span>
          relations(JSON{relationsIssue === null ? "" : " · 有错"})
        </button>
        {relationsOpen && (
          <>
            <p className="ui-micro leading-relaxed text-text-faint">
              每条:
              {"{ type, sourceKind, targetKind, reads, strength(weak|strong), " +
                "decisionClaimRef, decisionContentPin(sha256:…), rationale? }"}
              。留空数组表示不声明关系。
            </p>
            <textarea
              aria-label="relations JSON"
              value={relations}
              onChange={(event) => setRelations(event.target.value)}
              rows={6}
              spellCheck={false}
              className="rounded border border-border bg-surface p-2 font-mono ui-micro text-text"
            />
            {relationsIssue !== null && (
              <p data-testid="vertical-kind-relations-issue" className="ui-micro text-status-blocked">
                {relationsIssue}
              </p>
            )}
          </>
        )}
      </section>

      {error !== null && <p className="ui-meta text-status-blocked">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={!valid}>
          保存
        </button>
        <button type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  issue,
  hint,
  type = "text",
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly issue?: string | null;
  readonly hint?: string;
  readonly type?: string;
}) {
  return (
    <label className="flex flex-col gap-1 ui-meta text-text-muted">
      {label}
      <input aria-label={label} type={type} value={value} onChange={(event) => onChange(event.target.value)} />
      {issue ? (
        <span className="ui-micro text-status-blocked">{issue}</span>
      ) : (
        hint && <span className="ui-micro text-text-faint">{hint}</span>
      )}
    </label>
  );
}

const RELATION_REQUIRED_FIELDS = [
  "type",
  "sourceKind",
  "targetKind",
  "reads",
  "strength",
  "decisionClaimRef",
  "decisionContentPin",
] as const;

/**
 * relations 文本的校验:先 JSON 解析(错误定位到行列),再数组与条目结构(定位到下标)。
 * 结构判据镜像 kernel 的 ArtifactRelationSchema;真正的裁决在 daemon 写路上,这里只
 * 是让错误在提交前就能被看见、被定位。
 */
export function describeRelationsIssue(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    consumeKnownError(cause);
    return cause instanceof Error ? `JSON 解析失败:${locateJsonError(cause.message, text)}` : "JSON 解析失败。";
  }
  if (!Array.isArray(parsed)) return "relations 必须是 JSON 数组。";
  for (const [index, item] of parsed.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return `relations[${index}]:必须是对象。`;
    const record = item as Record<string, unknown>;
    const missing = RELATION_REQUIRED_FIELDS.filter((field) => typeof record[field] !== "string" || !record[field]);
    if (missing.length > 0) return `relations[${index}]:缺少字段 ${missing.join(", ")}。`;
    if (record.strength !== "weak" && record.strength !== "strong")
      return `relations[${index}]:strength 只能是 weak 或 strong。`;
    if (typeof record.decisionContentPin !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record.decisionContentPin))
      return `relations[${index}]:decisionContentPin 须为 sha256:<64 位十六进制>。`;
    const unknown = Object.keys(record).filter(
      (key) =>
        !RELATION_REQUIRED_FIELDS.includes(key as (typeof RELATION_REQUIRED_FIELDS)[number]) && key !== "rationale",
    );
    if (unknown.length > 0) return `relations[${index}]:未声明字段 ${unknown.join(", ")}。`;
  }
  return null;
}

/** V8 的 JSON.parse 错误带 (line L column C) 或 position P;统一换算成行列并给上下文。 */
export function locateJsonError(message: string, text: string): string {
  const lineColumn = /line (\d+) column (\d+)/u.exec(message);
  if (lineColumn) return `${message.split(" (line")[0]}(第 ${lineColumn[1]} 行第 ${lineColumn[2]} 列)`;
  const position = /position (\d+)/u.exec(message);
  if (position) {
    const offset = Number(position[1]);
    const before = text.slice(0, offset);
    const line = before.split("\n").length;
    const column = offset - (before.lastIndexOf("\n") + 1) + 1;
    return `${message.split(" at position")[0]}(第 ${line} 行第 ${column} 列)`;
  }
  return message;
}

function validPathTemplate(value: string): boolean {
  const segments = value.split("/");
  return (
    value.split("{id}").length === 2 &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
    !/[\\{}]/u.test(value.replace("{id}", ""))
  );
}

function csv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
