import type { AccessAction, AccessPolicyGroup } from "@harness-anything/authorization-gui/access-admin-contract";
import { createAccessModel } from "./access-model.js";
import type { MessageKey } from "./ui-host.js";
import type { KeycloakUiHost } from "./ui-host.js";

export function createGroupScopePreview(host: KeycloakUiHost) {
  const { currentLocale, t } = host;
  const { roleLabel } = createAccessModel(host);

  /** The nearest group under `groupId`'s inheritance that names `scope` itself, breadth-first over composites. */
  function inheritedSourceOf(
    groups: readonly AccessPolicyGroup[],
    groupId: string,
    scope: string,
  ): AccessPolicyGroup | undefined {
    const byId = new Map(groups.map((group) => [group.id, group] as const)),
      seen = new Set<string>([groupId]);
    let frontier = byId.get(groupId)?.composites ?? [];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        const group = byId.get(id);
        if (!group) continue;
        if (group.scopes.includes(scope)) return group;
        next.push(...group.composites);
      }
      frontier = next;
    }
    return undefined;
  }

  interface PreviewCategory {
    readonly domain: string;
    /** Actions the group declares itself versus the ones its composites bring in. */
    own: number;
    inherited: number;
    /** Lower groups the inherited actions resolve to, nearest declarer first. */
    readonly sources: AccessPolicyGroup[];
    readonly scopes: string[];
  }

  /**
   * What a group really grants: its effective actions grouped by the domain the declarations carry,
   * each category folded by default behind an「own N / inherited M」summary that names the lower
   * groups the inherited actions come from once. Rows show the declared name, description, and raw
   * scope with nothing repeated — an undeclared scope keeps the domain it id-spells and shows its
   * id only as the code chip.
   */
  function GroupScopePreview({
    group,
    groups,
    actions,
  }: {
    readonly group: AccessPolicyGroup;
    readonly groups: readonly AccessPolicyGroup[];
    readonly actions: readonly AccessAction[];
  }) {
    const declared = new Map(actions.map((action) => [action.action, action] as const)),
      byDomain = new Map<string, PreviewCategory>();
    for (const scope of group.effectiveScopes) {
      const declaration = declared.get(scope),
        separator = scope.indexOf("-"),
        domain = declaration?.presentation.domain ?? (separator < 0 ? scope : scope.slice(0, separator));
      const category = byDomain.get(domain) ?? { domain, own: 0, inherited: 0, sources: [], scopes: [] };
      category.scopes.push(scope);
      if (group.scopes.includes(scope)) category.own += 1;
      else {
        category.inherited += 1;
        const source = inheritedSourceOf(groups, group.id, scope);
        if (source && !category.sources.some((known) => known.id === source.id)) category.sources.push(source);
      }
      byDomain.set(domain, category);
    }
    const categories = [...byDomain.values()].sort((left, right) =>
      left.domain < right.domain ? -1 : left.domain > right.domain ? 1 : 0,
    );
    return (
      <div
        data-testid={`edge-invite-group-preview-${group.id}`}
        className="ml-6 flex flex-col gap-1 rounded border border-border bg-surface-raised px-2 py-1.5"
      >
        {group.effectiveScopes.length === 0 ? (
          <p className="ui-meta text-text-faint">{t("views.repositories.inviteGroupNoActions")}</p>
        ) : (
          <>
            <p className="ui-meta text-text-faint">
              {t("views.repositories.inviteGroupPreviewSummary", {
                total: group.effectiveScopes.length,
                own: categories.reduce((sum, category) => sum + category.own, 0),
                inherited: categories.reduce((sum, category) => sum + category.inherited, 0),
              })}
            </p>
            {categories.map((category) => (
              <details
                key={category.domain}
                data-testid={`edge-invite-group-preview-${group.id}-category-${category.domain}`}
                className="border-t border-border py-1"
              >
                <summary className="cursor-pointer ui-meta text-text">
                  <b>{t(`accessControl.domain.${category.domain}` as MessageKey)}</b>
                  <span className="ml-2 text-text-faint">
                    {t("views.repositories.inviteGroupCategoryOwn", { count: category.own })}
                    {" / "}
                    {t("views.repositories.inviteGroupCategoryInherited", { count: category.inherited })}
                  </span>
                  {category.sources.length > 0 ? (
                    <span className="ml-2 rounded bg-surface px-1 py-0.5 text-text-faint">
                      {t("views.repositories.inviteGroupInheritedFrom", {
                        group: category.sources
                          .map((source) => roleLabel(source.id, source.displayName))
                          .join(currentLocale() === "zh-CN" ? "、" : ", "),
                      })}
                    </span>
                  ) : null}
                </summary>
                {category.scopes.map((scope) => {
                  const declaration = declared.get(scope);
                  return (
                    <p key={scope} className="ui-meta text-text">
                      {declaration ? (
                        <>
                          <b>{declaration.presentation.name}</b>
                          <span className="ml-2 text-text-muted">{declaration.presentation.description}</span>
                        </>
                      ) : null}
                      <code className="ml-2 text-text-faint">{scope}</code>
                    </p>
                  );
                })}
              </details>
            ))}
          </>
        )}
      </div>
    );
  }
  return { GroupScopePreview };
}
