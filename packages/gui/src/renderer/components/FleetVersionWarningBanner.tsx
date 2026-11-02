import type { FleetOverviewRead } from "../../api/renderer-dto.ts";
import { t } from "../i18n/index.tsx";

export function FleetVersionWarningBanner({ warning }: { readonly warning: FleetOverviewRead["versionWarning"] }) {
  if (!warning) return null;
  return (
    <p
      data-testid="fleet-version-warning-banner"
      className="border-b border-status-blocked bg-surface-raised px-5 py-2 ui-meta text-status-blocked"
    >
      {t("collaboration.versionWarning", { command: warning.upgradeCommand })}
      <span className="ml-2 font-mono">
        center={warning.centerBuildCommit} local={warning.localBuildCommit}
      </span>
    </p>
  );
}
