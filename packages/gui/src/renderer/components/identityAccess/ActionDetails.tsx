import type { AccessAction } from "../../../api/access-admin-contract.ts";
import { currentLocale } from "../../i18n/core.ts";
import { t, type MessageKey } from "../../i18n/index.tsx";
import { BoundedContent } from "../primitives/BoundedContent.tsx";

/** The daemon projects these names directly from the authoritative action declarations. */
export function ActionDetails({
  actions,
  grouped = false,
}: {
  readonly actions: readonly AccessAction[];
  readonly grouped?: boolean;
}) {
  const domains = [...new Set(actions.map((action) => action.presentation.domain))];
  const groups = (
    <BoundedContent>
      {domains.map((domain) => (
        <details key={domain} className="border-t border-border py-2">
          <summary className="cursor-pointer font-semibold ui-body">
            {t(`accessControl.domain.${domain}` as MessageKey)} (
            {actions.filter((action) => action.presentation.domain === domain).length})
          </summary>
          {actions
            .filter((action) => action.presentation.domain === domain)
            .map((action) => (
              <p key={action.action} className="py-1 ui-body">
                <b>{currentLocale() === "zh-CN" ? action.presentation.name : action.action}</b>
                <span className="ml-2 text-text-muted">
                  {currentLocale() === "zh-CN" ? action.presentation.description : ""}
                </span>
                <code className="ml-2 text-text-faint ui-meta">{action.action}</code>
              </p>
            ))}
        </details>
      ))}
    </BoundedContent>
  );
  return grouped ? (
    groups
  ) : (
    <details>
      <summary className="cursor-pointer py-2 ui-body">
        {t("accessControl.roles.allActions")} ({actions.length})
      </summary>
      {groups}
    </details>
  );
}
