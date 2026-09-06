import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PencilSimple, Archive } from "@phosphor-icons/react";
import type { GovernedEntityRow } from "../../graph/governedEntities.ts";
import { entityKindQueryKeys } from "../../entity-kind-data.ts";
import { archiveEntity, receiptFailureText, updateEntity } from "../../entity-locator-client.ts";

/**
 * 实体详情的操作区(task_a494eac2 Goal 4):编辑/归档放在**详情**里,不再挤在列表行内。
 * 列表行只负责「是什么、去哪看」;改东西的动作聚到被选中实体的详情头部,与被操作
 * 对象同屏,避免 33 条实体每条都挂一排小按钮。
 *
 * 写路仍是 `repo.entity.update` / `repo.entity.archive` 两条 center 单写路;冲突由
 * center 的 revision fence 回报,这里如实展示、不重试。
 */
export function EntityDetailActions({
  repoId,
  entity,
}: {
  readonly repoId: string;
  readonly entity: GovernedEntityRow;
}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"edit" | "archive" | null>(null);
  const [title, setTitle] = useState(entity.title ?? "");
  const [locator, setLocator] = useState(entity.locator?.value ?? "");
  const [contentVersion, setContentVersion] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const finish = (receipt: { readonly outcome: string; readonly [key: string]: unknown }) => {
    if (receipt.outcome !== "applied" && receipt.outcome !== "no_changes") {
      setError(receiptFailureText(receipt));
      return;
    }
    setMode(null);
    void queryClient.invalidateQueries({ queryKey: entityKindQueryKeys.rows(repoId) });
  };
  if (entity.archived)
    return (
      <p
        data-testid="entity-detail-actions-archived"
        className="border-b border-border px-3 py-1.5 ui-micro text-text-faint"
      >
        已归档实体只读;需要复活时走 CLI relink 语义。
      </p>
    );
  return (
    <div className="border-b border-border px-3 py-2" data-testid="entity-detail-actions">
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="entity-detail-edit"
          onClick={() => setMode(mode === "edit" ? null : "edit")}
          className={[
            "inline-flex items-center gap-1 rounded-md border border-border px-2 py-1",
            "ui-micro text-text-muted hover:border-border-strong hover:text-text",
          ].join(" ")}
        >
          <PencilSimple weight="bold" className="ui-micro" />
          编辑
        </button>
        <button
          type="button"
          data-testid="entity-detail-archive"
          onClick={() => setMode(mode === "archive" ? null : "archive")}
          className={[
            "inline-flex items-center gap-1 rounded-md border border-border px-2 py-1",
            "ui-micro text-text-muted hover:border-border-strong hover:text-text",
          ].join(" ")}
        >
          <Archive weight="bold" className="ui-micro" />
          归档
        </button>
        {mode === null && <span className="ui-micro text-text-faint">编辑与归档作用于当前选中的实体。</span>}
      </div>
      {mode === "edit" && (
        <form
          data-testid="entity-detail-edit-form"
          className="mt-2 flex flex-col gap-1"
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
            placeholder="contentVersion(可选)"
          />
          {entity.locator?.kind === "repository-path" && <span>保存后右侧预览会刷新。</span>}
          <button type="submit" data-testid="entity-detail-edit-save">
            保存
          </button>
        </form>
      )}
      {mode === "archive" && (
        <form
          data-testid="entity-detail-archive-form"
          className="mt-2 flex flex-col gap-1"
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
            aria-label="归档原因"
            required
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="归档原因"
          />
          <button type="submit" data-testid="entity-detail-archive-confirm">
            确认归档
          </button>
        </form>
      )}
      {error && (
        <p data-testid="entity-detail-action-error" className="ui-micro text-status-blocked">
          {error}
        </p>
      )}
    </div>
  );
}
