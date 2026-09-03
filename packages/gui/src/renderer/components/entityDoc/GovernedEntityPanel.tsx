import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "@phosphor-icons/react";
import type { EntityKindRow } from "../../entity-kind-catalog-client.ts";
import type { GovernedEntityRow } from "../../graph/governedEntities.ts";
import { entityKindQueryKeys, useGovernedEntityRows } from "../../entity-kind-data.ts";
import { importEntity } from "../../entity-locator-client.ts";
import { EntityLocatorPreview } from "./EntityLocatorPreview.tsx";
import { NewGovernedEntityForm, type NewGovernedEntityInput } from "./NewGovernedEntityForm.tsx";

/**
 * 声明实体的实况面:这个 kind 现在有哪些实体、点开看它的正文、以及新建一个。
 *
 * 「新建」按钮只在读面说这个 kind `importable` 时出现——判据是它有没有可执行的 import
 * 动作,不是一份写死的可写 kind 名单。提交走 `repo.entity.import`,与 CLI 同一条写路。
 */
export function GovernedEntityPanel({
  repoId,
  row,
  selectedEntityRef,
}: {
  readonly repoId: string;
  readonly row: EntityKindRow;
  readonly selectedEntityRef: string | null;
}) {
  const rows = useGovernedEntityRows(repoId).filter((entity) => entity.kind === row.kind);
  const [selected, setSelected] = useState<string | null>(selectedEntityRef);
  const active = rows.find((entity) => entity.ref === (selected ?? selectedEntityRef)) ?? rows[0] ?? null;
  return (
    <section data-testid={`governed-entity-panel`} className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="ui-body font-semibold">本仓实体</h2>
        <span className="ui-micro text-text-faint">{rows.length} 条</span>
        {row.importable && <NewEntityControl repoId={repoId} row={row} />}
      </header>
      {rows.length === 0 ? (
        <p data-testid="governed-entity-empty" className="ui-meta text-text-faint">
          本仓还没有这个 kind 的实体。
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-[minmax(220px,320px)_1fr]">
          <ul data-testid="governed-entity-list" className="flex max-h-96 flex-col gap-1 overflow-y-auto">
            {rows.map((entity) => (
              <li key={entity.ref}>
                <button
                  type="button"
                  data-testid={`governed-entity-row-${entity.entityId}`}
                  onClick={() => setSelected(entity.ref)}
                  className={[
                    "w-full rounded-md border px-2 py-1.5 text-left",
                    entity.ref === active?.ref
                      ? "border-border-strong bg-surface-raised"
                      : "border-border hover:bg-surface-raised",
                  ].join(" ")}
                >
                  <span className="block truncate ui-meta text-text">{entity.title ?? entity.entityId}</span>
                  <span className="block truncate font-mono ui-micro text-text-faint">
                    {entity.locator?.value ?? entity.entityId}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex min-h-0 flex-col rounded-md border border-border">
            {active === null || active.locator === null ? (
              <p className="p-4 ui-meta text-text-faint">这条实体没有 locator,没有可渲染的正文。</p>
            ) : (
              <EntityLocatorPreview repoId={repoId} locator={active.locator} />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function NewEntityControl({ repoId, row }: { readonly repoId: string; readonly row: EntityKindRow }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (input: NewGovernedEntityInput) => {
    setBusy(true);
    setError(null);
    void importEntity({
      repoId,
      entityKind: row.kind,
      locator: input.locator,
      ...(input.title ? { title: input.title } : {}),
    })
      .then((receipt) => {
        // 冲突/拒绝只展示,不重试——重试语义在 center 的 revision fence 上,不在 GUI。
        if (receipt.outcome !== "applied" && receipt.outcome !== "no_changes") {
          setError(importFailureText(receipt));
          return;
        }
        setOpen(false);
        void queryClient.invalidateQueries({ queryKey: entityKindQueryKeys.rows(repoId) });
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <button
        type="button"
        data-testid="governed-entity-new"
        onClick={() => setOpen((value) => !value)}
        className={[
          "inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 ui-meta text-text-muted",
          "hover:border-border-strong hover:text-text",
        ].join(" ")}
      >
        <Plus weight="bold" />
        新建
      </button>
      {open && (
        <div className="w-full">
          <NewGovernedEntityForm
            row={row}
            busy={busy}
            error={error}
            onCancel={() => setOpen(false)}
            onSubmit={submit}
          />
        </div>
      )}
    </>
  );
}

function importFailureText(receipt: { readonly outcome: string; readonly [key: string]: unknown }): string {
  const explanation = receipt.rejectionExplanation;
  const code = (receipt.error as { readonly code?: string } | undefined)?.code;
  return typeof explanation === "string" && explanation.length > 0
    ? explanation
    : `entity import 返回 ${receipt.outcome}${code ? `(${code})` : ""}。`;
}

export type { GovernedEntityRow };
