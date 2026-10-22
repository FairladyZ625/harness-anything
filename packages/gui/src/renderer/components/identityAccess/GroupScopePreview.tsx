import type { AccessAction, AccessPolicyGroup } from "../../../api/access-admin-contract.ts";
import { inheritedScopes, roleLabel } from "../../access-model.ts";
import { currentLocale } from "../../i18n/core.ts";
import { t } from "../../i18n/index.tsx";

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

/**
 * What a group really grants: every effective action with its declared human-readable name, and a
 * badge naming the lower group each inherited action comes from — own scopes win over inheritance,
 * as the daemon's set union does.
 */
export function GroupScopePreview({
  group,
  groups,
  actions,
}: {
  readonly group: AccessPolicyGroup;
  readonly groups: readonly AccessPolicyGroup[];
  readonly actions: readonly AccessAction[];
}) {
  const inherited = inheritedScopes(groups, group.composites),
    declared = new Map(actions.map((action) => [action.action, action] as const));
  return (
    <div
      data-testid={`edge-invite-group-preview-${group.id}`}
      className="ml-6 flex flex-col gap-1 rounded border border-border bg-surface-raised px-2 py-1.5"
    >
      {group.effectiveScopes.length === 0 ? (
        <p className="ui-meta text-text-faint">{t("views.repositories.inviteGroupNoActions")}</p>
      ) : null}
      {group.effectiveScopes.map((scope) => {
        const declaration = declared.get(scope),
          source =
            inherited.has(scope) && !group.scopes.includes(scope)
              ? inheritedSourceOf(groups, group.id, scope)
              : undefined;
        return (
          <p key={scope} className="ui-meta text-text">
            {source ? (
              <span
                title={t("accessControl.groups.inheritedAction")}
                className="mr-2 rounded bg-surface px-1 py-0.5 text-text-faint"
              >
                {t("views.repositories.inviteGroupInheritedFrom", {
                  group: roleLabel(source.id, source.displayName),
                })}
              </span>
            ) : null}
            <b>{currentLocale() === "zh-CN" ? (declaration?.presentation.name ?? scope) : scope}</b>
            {currentLocale() === "zh-CN" && declaration ? (
              <span className="ml-2 text-text-muted">{declaration.presentation.description}</span>
            ) : null}
            <code className="ml-2 text-text-faint">{scope}</code>
          </p>
        );
      })}
    </div>
  );
}
