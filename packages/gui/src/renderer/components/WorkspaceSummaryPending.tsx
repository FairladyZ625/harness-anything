import { t } from "../i18n/index.tsx";

export function WorkspaceSummaryPending({ error }: { error: unknown }) {
  return <div className="m-5 rounded-lg border border-border p-4 text-[13px] text-text-faint">{error instanceof Error ? error.message : t("components.appSidebar.readLocalLedger")}</div>;
}
