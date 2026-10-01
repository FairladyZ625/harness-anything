import { useState } from "react";
import { AccessServiceTab } from "../components/identityAccess/AccessServiceTab.tsx";
import { GrantsTab } from "../components/identityAccess/GrantsTab.tsx";
import { PolicyGroupsTab } from "../components/identityAccess/PolicyGroupsTab.tsx";
import { ReceiptsTab } from "../components/identityAccess/ReceiptsTab.tsx";
import { TabPanel } from "../components/primitives/EntryBoundary.tsx";
import { Tabs } from "../components/primitives/Tabs.tsx";
import { guiHostBridge } from "../gui-transport.ts";
import { t } from "../i18n/index.tsx";

type AccessTab = "service" | "groups" | "grants" | "receipts";

/**
 * Accounts and access control. Every tab is a region board whose ruler is the tab panel: at 900px
 * and wider the board fills the height under the tab bar and regions scroll inside themselves;
 * narrower, it stacks into one column and the panel scrolls.
 */
export function IdentityAccessView({
  repos = [],
  repoId,
}: {
  readonly repoId?: string;
  readonly repos?: readonly { readonly repoId: string; readonly displayName: string }[];
}) {
  const bridge = guiHostBridge(),
    auth = bridge?.auth && typeof bridge.auth.status === "function" ? bridge.auth : undefined,
    access = bridge?.access?.forRepository(repoId),
    [tab, setTab] = useState<AccessTab>("service");

  if (!auth) return <p role="alert">{t("identityAccess.electronOnly")}</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="identity-access-view">
      <header className="flex flex-wrap items-baseline gap-3 px-5 py-3">
        <h1 className="text-xl font-semibold text-text">{t("identityAccess.title")}</h1>
        <span className="min-w-0 truncate text-sm text-text-muted">{t("accessControl.tagline")}</span>
      </header>
      <div className="px-5">
        <Tabs
          ariaLabel={t("identityAccess.title")}
          idPrefix="identity-access"
          value={tab}
          onChange={setTab}
          tabs={[
            { key: "service" as const, label: t("accessControl.tab.service") },
            ...(access
              ? [
                  { key: "groups" as const, label: t("accessControl.tab.groups") },
                  { key: "grants" as const, label: t("accessControl.tab.grants") },
                  { key: "receipts" as const, label: t("accessControl.tab.receipts") },
                ]
              : []),
          ]}
        />
      </div>
      <TabPanel
        idPrefix="identity-access"
        value={tab}
        className="@container flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
      >
        {tab === "service" || !access ? (
          <AccessServiceTab key={repoId ?? "local"} auth={auth} access={access} repoId={repoId} />
        ) : tab === "groups" ? (
          <PolicyGroupsTab access={access} />
        ) : tab === "grants" ? (
          <GrantsTab access={access} repos={repos} />
        ) : (
          <ReceiptsTab access={access} />
        )}
      </TabPanel>
    </div>
  );
}
