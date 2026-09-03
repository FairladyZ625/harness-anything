import { useMemo, useState } from "react";
import type { EntityKindRow } from "../../entity-kind-catalog-client.ts";

/**
 * 声明实体的新建表单。**字段不是手写的**——它来自该 kind 的 import 动作合同
 * (`explanation.transitions.actions[id=import].input.fields`,与 CLI `ha entity import`
 * 的 flag 表同一个值),locator kind 的词表来自声明的 `locatorKinds`。
 *
 * 三个字段不出现在表单里,各有原因:
 *   - `entityKind` 由所在页面钉死(否则 kind 就有了第二个来源);
 *   - `expectedVersion` 新建恒为 0(新实体没有既有 revision),冲突由 center 的 fence 回报;
 *   - `entityId` / `sourceIdentity` 是 relink 语义、必须成对出现,不开放给渲染层。
 */
export interface NewGovernedEntityInput {
  readonly locatorKind: string;
  readonly locator: string;
  readonly title: string;
}

const HIDDEN_FIELDS = new Set([
  "entityKind",
  "expectedVersion",
  "entityId",
  "sourceIdentity",
  "idempotencyKey",
  "dryRun",
]);

export function importActionFields(row: EntityKindRow): readonly { field: string; required: boolean }[] {
  const action = row.explanation.transitions.actions.find(({ id }) => id === "import");
  return (action?.input?.fields ?? [])
    .filter(({ field }) => !HIDDEN_FIELDS.has(field))
    .map(({ field, required }) => ({ field, required }));
}

export function NewGovernedEntityForm({
  row,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  readonly row: EntityKindRow;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSubmit: (input: NewGovernedEntityInput) => void;
}) {
  const locatorKinds = row.declaration?.locatorKinds ?? [];
  const fields = useMemo(() => importActionFields(row), [row]);
  const [locatorKind, setLocatorKind] = useState(locatorKinds[0] ?? "repository-path");
  const [locator, setLocator] = useState("");
  const [title, setTitle] = useState("");
  const locatorRequired = fields.find(({ field }) => field === "locator")?.required ?? true;
  const valid = !busy && (!locatorRequired || locator.trim().length > 0);

  return (
    <form
      data-testid="new-governed-entity-form"
      className="flex flex-col gap-3 rounded-md border border-border bg-surface-raised p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        onSubmit({ locatorKind, locator: locator.trim(), title: title.trim() });
      }}
    >
      <p className="ui-meta text-text-faint">
        新建 {row.declaration?.display.singular ?? row.kind}:账本里只记描述符,正文留在 locator 指向的地方。
      </p>
      {locatorKinds.length > 1 && (
        <label className="flex flex-col gap-1 ui-meta text-text-muted">
          locator 类型
          <select
            data-testid="new-governed-entity-locator-kind"
            value={locatorKind}
            onChange={(event) => setLocatorKind(event.target.value)}
            className="rounded border border-border bg-surface px-2 py-1 font-mono ui-meta text-text"
          >
            {locatorKinds.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
      )}
      {fields.map(({ field, required }) =>
        field === "locator" ? (
          <label key={field} className="flex flex-col gap-1 ui-meta text-text-muted">
            locator{required ? " *" : ""}
            <input
              data-testid="new-governed-entity-locator"
              value={locator}
              onChange={(event) => setLocator(event.target.value)}
              placeholder={locatorKinds.length === 1 ? locatorKinds[0] : locatorKind}
              className="rounded border border-border bg-surface px-2 py-1 font-mono ui-meta text-text"
            />
          </label>
        ) : field === "title" ? (
          <label key={field} className="flex flex-col gap-1 ui-meta text-text-muted">
            title{required ? " *" : ""}
            <input
              data-testid="new-governed-entity-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="留空则由内容首行推断"
              className="rounded border border-border bg-surface px-2 py-1 ui-meta text-text"
            />
          </label>
        ) : (
          // 合同里出现了这一页还没有控件的输入字段:如实列出,不静默丢。
          <p key={field} data-testid={`new-governed-entity-unsupported-${field}`} className="ui-micro text-text-faint">
            合同字段 {field} 在这一页没有输入控件,请用 CLI `ha entity import` 提交。
          </p>
        ),
      )}
      {error !== null && (
        <p data-testid="new-governed-entity-error" className="ui-meta text-status-blocked">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={!valid}
          data-testid="new-governed-entity-submit"
          className={[
            "rounded-md border border-border px-2 py-1 ui-meta",
            valid ? "text-text hover:border-border-strong" : "cursor-not-allowed text-text-faint",
          ].join(" ")}
        >
          {busy ? "提交中…" : "创建"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          data-testid="new-governed-entity-cancel"
          className="rounded-md border border-border px-2 py-1 ui-meta text-text-muted hover:text-text"
        >
          取消
        </button>
      </div>
    </form>
  );
}
