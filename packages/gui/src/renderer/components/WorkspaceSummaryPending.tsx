import { t } from "../i18n/index.tsx";

export function WorkspaceSummaryPending({ error }: { error: unknown }) {
  const authenticationRequired = error instanceof Error && "code" in error && error.code === "authentication_required";
  return (
    <div className="m-5 rounded-lg border border-border p-4 ui-body text-text-faint">
      {authenticationRequired
        ? t("components.workspaceSummary.authenticationRequired")
        : error instanceof Error
          ? error.message
          : t("components.appSidebar.readLocalLedger")}
    </div>
  );
}
