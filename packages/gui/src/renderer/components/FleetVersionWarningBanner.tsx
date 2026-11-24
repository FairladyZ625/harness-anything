import { t } from "../i18n/index.tsx";

export function FleetVersionWarningBanner({ upgradeRequired }: { readonly upgradeRequired: boolean }) {
  if (!upgradeRequired) return null;
  return (
    <p
      data-testid="fleet-version-warning-banner"
      className="border-b border-status-blocked bg-surface-raised px-5 py-2 ui-meta text-status-blocked"
    >
      {t("collaboration.versionWarning", { command: "git pull --ff-only, then build CLI and daemon" })}
    </p>
  );
}
