import { useState } from "react";
import type { DaemonGuiReadPayloadMap } from "@harness-anything/daemon/protocol";
import { t } from "../i18n/index.tsx";
import type { MemberScopeContext } from "../use-member-scope-lens.ts";

export type CollaboratorFilterOptions = Pick<
  MemberScopeContext,
  "scopePersonId" | "currentPersonId" | "lensMembers" | "nodeOptions"
>;

export function useCollaboratorFilters(options?: CollaboratorFilterOptions) {
  const [person, setPerson] = useState<string | null>(null);
  const [node, setNode] = useState<string | null>(null);
  const scopePersonId = options?.scopePersonId ?? null;
  const current = options?.currentPersonId ?? null;
  const personId =
    person === current || options?.lensMembers.some(({ personId }) => personId === person) ? person : null;
  const nodeId = options?.nodeOptions.some(({ nodeId }) => nodeId === node) ? node : null;
  return {
    person: scopePersonId ?? personId,
    node: nodeId,
    setPerson,
    setNode,
    query: {
      ...(scopePersonId === null ? {} : { scopePersonId }),
      ...(scopePersonId !== null || personId === null ? {} : { filterPersonId: personId }),
      ...(nodeId === null ? {} : { filterNodeId: nodeId }),
    } satisfies DaemonGuiReadPayloadMap["repo.works.index"],
  };
}

export function CollaboratorFilters({
  options,
  selection,
}: {
  readonly options: CollaboratorFilterOptions;
  readonly selection: ReturnType<typeof useCollaboratorFilters>;
}) {
  const fieldClass = "max-w-full rounded border border-border bg-surface-raised px-2 py-1 ui-meta text-text";
  return (
    <div className="flex min-w-0 flex-wrap gap-2 px-3 py-1">
      <label className="flex min-w-0 items-center gap-1.5 ui-meta text-text-muted">
        {t("components.taskFilterBar.person")}
        <select
          className={fieldClass}
          data-testid="collaborator-filter-person"
          value={selection.person ?? ""}
          disabled={options.scopePersonId !== null}
          onChange={(event) => selection.setPerson(event.target.value || null)}
        >
          <option value="">{t("components.scopeLens.all")}</option>
          {options.currentPersonId && <option value={options.currentPersonId}>{t("components.scopeLens.me")}</option>}
          {options.lensMembers
            .filter(({ personId }) => personId !== options.currentPersonId)
            .map(({ personId, label }) => (
              <option key={personId} value={personId}>
                {label}
              </option>
            ))}
        </select>
      </label>
      <label className="flex min-w-0 items-center gap-1.5 ui-meta text-text-muted">
        {t("components.taskFilterBar.node")}
        <select
          className={fieldClass}
          data-testid="collaborator-filter-node"
          value={selection.node ?? ""}
          onChange={(event) => selection.setNode(event.target.value || null)}
        >
          <option value="">{t("components.scopeLens.all")}</option>
          {options.nodeOptions.map(({ nodeId, label }) => (
            <option key={nodeId} value={nodeId}>
              {label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
