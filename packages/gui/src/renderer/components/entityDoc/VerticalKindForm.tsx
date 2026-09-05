import { useState } from "react";
import type { ArtifactKindDeclaration } from "../../vertical-kind-client.ts";
import { consumeKnownError } from "../../../api/error-consumption.ts";

const PREFIX = /^[A-Z][A-Z0-9]{0,15}$/u;
const KIND_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

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
  const [singular, setSingular] = useState(initial?.display.singular ?? "");
  const [plural, setPlural] = useState(initial?.display.plural ?? "");
  const [schemaRef, setSchemaRef] = useState(initial?.descriptorSchemaRef ?? "schema://artifact-descriptor");
  const [pathTemplate, setPathTemplate] = useState(initial?.store.pathTemplate ?? "entities/{id}.json");
  const [locatorKinds, setLocatorKinds] = useState(initial?.locatorKinds.join(", ") ?? "repository-path");
  const [maturity, setMaturity] = useState(initial?.maturityVocabulary?.join(", ") ?? "");
  const [relations, setRelations] = useState(JSON.stringify(initial?.relations ?? [], null, 2));
  const [parseError, setParseError] = useState<string | null>(null);
  const prefixError = PREFIX.test(idPrefix) ? null : "须为 1–16 位大写字母/数字，首位必须是字母。";
  const pathError = validPathTemplate(pathTemplate) ? null : "须为规范相对路径，并且恰好包含一个 {id}。";
  const valid = !busy && KIND_ID.test(id) && !prefixError && !pathError && singular.trim() && plural.trim();
  return (
    <form
      data-testid="vertical-kind-form"
      className="mt-3 flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        try {
          setParseError(null);
          const parsedRelations = JSON.parse(relations) as unknown;
          if (!Array.isArray(parsedRelations)) throw new Error("relations 必须是 JSON 数组。");
          onSubmit({
            id,
            entityType: "artifact",
            version: Number(version),
            idPrefix,
            display: { singular: singular.trim(), plural: plural.trim() },
            descriptorSchemaRef: schemaRef.trim(),
            store: { pathTemplate },
            locatorKinds: csv(locatorKinds) as ArtifactKindDeclaration["locatorKinds"],
            ...(maturity.trim() ? { maturityVocabulary: csv(maturity) } : {}),
            ...(parsedRelations.length ? { relations: parsedRelations } : {}),
          });
        } catch (cause) {
          consumeKnownError(cause);
          setParseError(cause instanceof Error ? cause.message : String(cause));
        }
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <Field label="id" value={id} onChange={setId} disabled={initial !== undefined} />
        <Field label="version" value={version} onChange={setVersion} disabled={initial !== undefined} type="number" />
        <Field
          label="idPrefix"
          value={idPrefix}
          onChange={setIdPrefix}
          disabled={initial !== undefined}
          issue={prefixError}
        />
        <Field label="display.singular" value={singular} onChange={setSingular} />
        <Field label="display.plural" value={plural} onChange={setPlural} />
        <Field label="descriptorSchemaRef" value={schemaRef} onChange={setSchemaRef} />
        <Field
          label="store.pathTemplate"
          value={pathTemplate}
          onChange={setPathTemplate}
          disabled={initial !== undefined}
          issue={pathError}
        />
        <Field label="locatorKinds (逗号分隔)" value={locatorKinds} onChange={setLocatorKinds} />
        <Field label="maturityVocabulary (逗号分隔)" value={maturity} onChange={setMaturity} />
      </div>
      <label className="flex flex-col gap-1 ui-meta text-text-muted">
        relations (JSON)
        <textarea value={relations} onChange={(event) => setRelations(event.target.value)} rows={5} />
      </label>
      {initial && (
        <p className="ui-micro text-text-faint">
          id、version、idPrefix 与 pathTemplate 是身份/存储字段，编辑时不可变。
        </p>
      )}
      {(error ?? parseError) && <p className="ui-meta text-status-blocked">{error ?? parseError}</p>}
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
  disabled,
  issue,
  type = "text",
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly issue?: string | null;
  readonly type?: string;
}) {
  return (
    <label className="flex flex-col gap-1 ui-meta text-text-muted">
      {label}
      <input
        aria-label={label}
        type={type}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      {issue && <span className="ui-micro text-status-blocked">{issue}</span>}
    </label>
  );
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
