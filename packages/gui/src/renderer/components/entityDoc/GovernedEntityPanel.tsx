import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "@phosphor-icons/react";
import type { EntityKindRow } from "../../entity-kind-catalog-client.ts";
import type { GovernedEntityRow } from "../../graph/governedEntities.ts";
import { entityKindQueryKeys } from "../../entity-kind-data.ts";
import { archiveEntity, importEntity, updateEntity } from "../../entity-locator-client.ts";
import { NewGovernedEntityForm, type NewGovernedEntityInput } from "./NewGovernedEntityForm.tsx";

/**
 * 声明实体的实况面·左列形态:这个 kind 现在有哪些实体、搜一个、新建一个。
 * 选中哪条的正文渲染在详情页右栏(EntityLocatorPreview),所以选择状态上提到
 * EntityDocDetailView,本组件只报 `onSelect`。
 *
 * 「新建」按钮只在读面说这个 kind `importable` 时出现——判据是它有没有可执行的 import
 * 动作,不是一份写死的可写 kind 名单。提交走 `repo.entity.import`,与 CLI 同一条写路。
 */
export function GovernedEntityPanel({
  repoId,
  row,
  rows,
  selectedRef,
  onSelect,
}: {
  readonly repoId: string;
  readonly row: EntityKindRow;
  readonly rows: readonly GovernedEntityRow[];
  readonly selectedRef: string | null;
  readonly onSelect: (ref: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const needle = query.trim().toLowerCase();
  const activeRows = showArchived ? rows : rows.filter((entity) => !entity.archived);
  const visible =
    needle === ""
      ? activeRows
      : activeRows.filter((entity) =>
          [entity.title ?? "", entity.entityId, entity.locator?.value ?? ""].some((text) =>
            text.toLowerCase().includes(needle),
          ),
        );
  return (
    <section data-testid="governed-entity-panel" className="mt-6 border-t border-border pt-4">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="ui-body font-semibold">本仓实体</h2>
        <span className="ui-micro text-text-faint">{rows.length} 条</span>
        {row.importable && <NewEntityControl repoId={repoId} row={row} />}
        <label className="ml-auto ui-micro text-text-faint">
          <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
          显示已归档
        </label>
      </header>
      {rows.length === 0 ? (
        <p data-testid="governed-entity-empty" className="mt-2 ui-meta text-text-faint">
          本仓还没有这个 kind 的实体。
        </p>
      ) : (
        <>
          <input
            type="search"
            data-testid="governed-entity-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题 / id / locator"
            className={[
              "mt-2 w-full rounded-md border border-border bg-surface px-2 py-1 ui-meta",
              "text-text placeholder:text-text-faint focus:border-border-strong focus:outline-none",
            ].join(" ")}
          />
          {visible.length === 0 ? (
            <p data-testid="governed-entity-search-empty" className="mt-2 ui-meta text-text-faint">
              没有匹配「{query.trim()}」的实体。
            </p>
          ) : (
            <ul data-testid="governed-entity-list" className="mt-2 flex flex-col gap-1">
              {visible.map((entity) => (
                <li key={entity.ref}>
                  <div
                    className={[
                      "w-full rounded-md border px-2 py-1.5 text-left",
                      entity.archived ? "opacity-50" : "",
                      entity.ref === selectedRef
                        ? "border-border-strong bg-surface-raised"
                        : "border-border hover:bg-surface-raised",
                    ].join(" ")}
                  >
                    <button
                      type="button"
                      data-testid={`governed-entity-row-${entity.entityId}`}
                      onClick={() => onSelect(entity.ref)}
                      className="w-full text-left"
                    >
                      <span className="block truncate ui-meta text-text">{entity.title ?? entity.entityId}</span>
                      <span className="block truncate font-mono ui-micro text-text-faint">
                        {entity.locator?.value ?? entity.entityId}
                      </span>
                    </button>
                    {!entity.archived && <EntityMutationControls repoId={repoId} entity={entity} />}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function EntityMutationControls({ repoId, entity }: { readonly repoId: string; readonly entity: GovernedEntityRow }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"edit" | "archive" | null>(null);
  const [title, setTitle] = useState(entity.title ?? "");
  const [locator, setLocator] = useState(entity.locator?.value ?? "");
  const [contentVersion, setContentVersion] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const finish = (receipt: { readonly outcome: string; readonly [key: string]: unknown }) => {
    if (receipt.outcome !== "applied" && receipt.outcome !== "no_changes") return setError(importFailureText(receipt));
    setMode(null);
    void queryClient.invalidateQueries({ queryKey: entityKindQueryKeys.rows(repoId) });
  };
  return (
    <div className="mt-1 flex flex-wrap gap-1 ui-micro">
      <button type="button" onClick={() => setMode("edit")}>
        编辑
      </button>
      <button type="button" onClick={() => setMode("archive")}>
        归档
      </button>
      {mode === "edit" && (
        <form
          className="flex w-full flex-col gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            void updateEntity({
              repoId,
              entityKind: entity.kind,
              entityId: entity.entityId,
              expectedVersion: entity.revision,
              title,
              locator,
              ...(contentVersion ? { contentVersion } : {}),
            })
              .then(finish)
              .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
          }}
        >
          <input aria-label="title" value={title} onChange={(event) => setTitle(event.target.value)} />
          <input
            aria-label={`${entity.locator?.kind ?? "locator"} locator`}
            value={locator}
            onChange={(event) => setLocator(event.target.value)}
          />
          <input
            aria-label="content version"
            value={contentVersion}
            onChange={(event) => setContentVersion(event.target.value)}
          />
          {entity.locator?.kind === "repository-path" && <span>保存后右侧 Markdown 预览会刷新。</span>}
          {entity.locator?.kind === "url" && <span>URL 可达性由导入/预览读面提示。</span>}
          <button type="submit">保存</button>
        </form>
      )}
      {mode === "archive" && (
        <form
          className="flex w-full gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            void archiveEntity({
              repoId,
              entityKind: entity.kind,
              entityId: entity.entityId,
              expectedVersion: entity.revision,
              reason,
            })
              .then(finish)
              .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
          }}
        >
          <input
            aria-label="archive reason"
            required
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <button type="submit">确认归档</button>
        </form>
      )}
      {error && <span className="w-full text-status-blocked">{error}</span>}
    </div>
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
