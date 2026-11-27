import { Button } from "./primitives/Button.tsx";
import { t } from "../i18n/index.tsx";

export function FleetVersionWarningBanner({
  upgradeRequired,
  onOpenUpdates,
}: {
  readonly upgradeRequired: boolean;
  readonly onOpenUpdates?: () => void;
}) {
  if (!upgradeRequired) return null;
  return (
    <div
      data-testid="fleet-version-warning-banner"
      className="flex flex-wrap items-center justify-between gap-2 border-b border-status-blocked bg-surface-raised px-5 py-2 ui-meta text-status-blocked"
    >
      <p className="m-0">{t("collaboration.versionWarning", { command: "ha edge upgrade" })}</p>
      {onOpenUpdates ? (
        <Button size="sm" testId="fleet-version-warning-open-updates" onClick={onOpenUpdates}>
          {t("collaboration.openUpdates")}
        </Button>
      ) : null}
    </div>
  );
}
