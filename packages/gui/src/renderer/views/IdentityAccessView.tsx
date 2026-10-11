import { DevicesTab } from "../components/identityAccess/DevicesTab.tsx";
import { TeamsTab } from "../components/identityAccess/TeamsTab.tsx";
import { useEffect, useState } from "react";
import { AccessServiceTab } from "../components/identityAccess/AccessServiceTab.tsx";
import { GrantsTab } from "../components/identityAccess/GrantsTab.tsx";
import { PolicyGroupsTab } from "../components/identityAccess/PolicyGroupsTab.tsx";
import { ReceiptsTab } from "../components/identityAccess/ReceiptsTab.tsx";
import type { RepoMode } from "../components/RepoModeBadge.tsx";
import { TabPanel } from "../components/primitives/EntryBoundary.tsx";
import { Tabs } from "../components/primitives/Tabs.tsx";
import { IdText } from "../components/IdText.tsx";
import { guiHostBridge } from "../gui-transport.ts";
import { t } from "../i18n/index.tsx";

type AccessTab = "devices" | "service" | "teams" | "groups" | "grants" | "receipts";

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
  readonly repos?: readonly {
    readonly repoId: string;
    readonly displayName: string;
    readonly mode?: RepoMode;
  }[];
}) {
  const bridge = guiHostBridge(),
    auth = bridge?.auth && typeof bridge.auth.status === "function" ? bridge.auth : undefined,
    access = bridge?.access?.forRepository(repoId),
    [tab, setTab] = useState<AccessTab>("grants");

  const [identity, setIdentity] = useState<string>("");
  useEffect(() => {
    const refreshIdentity = () => {
      if (auth)
        void auth.status(repoId).then((reply) => {
          const status = reply as { readonly authenticated?: boolean; readonly personId?: string };
          setIdentity(status.authenticated ? String(status.personId) : t("identityAccess.signedOut"));
        });
    };
    refreshIdentity();
    window.addEventListener("harness-auth-changed", refreshIdentity);
    return () => window.removeEventListener("harness-auth-changed", refreshIdentity);
  }, [auth, repoId]);
  if (!auth) return <p role="alert">{t("identityAccess.electronOnly")}</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="identity-access-view">
      <header className="flex flex-wrap items-baseline gap-3 px-5 py-3">
        <h1 className="text-xl font-semibold text-text">{t("identityAccess.title")}</h1>
        <span data-testid="access-current-account" className="ui-body">
          {t("accessControl.members.identity")}: <IdText value={identity} className="text-text" />
        </span>
        <span className="min-w-0 truncate text-sm text-text-muted">{t("accessControl.tagline")}</span>
      </header>
      <div className="px-5">
        <Tabs
          ariaLabel={t("identityAccess.title")}
          idPrefix="identity-access"
          value={tab}
          onChange={setTab}
          tabs={[
            ...(access
              ? [
                  { key: "devices" as const, label: t("devices.title") },
                  { key: "grants" as const, label: t("accessControl.tab.grants") },
                  { key: "groups" as const, label: t("accessControl.tab.groups") },
                  { key: "teams" as const, label: t("accessControl.teams.title") },
                  { key: "service" as const, label: t("accessControl.tab.service") },
                  { key: "receipts" as const, label: t("accessControl.tab.receipts") },
                ]
              : [{ key: "service" as const, label: t("accessControl.tab.service") }]),
          ]}
        />
      </div>
      <TabPanel
        idPrefix="identity-access"
        value={tab}
        className="@container flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
      >
        {tab === "service" || !access ? (
          <AccessServiceTab
            key={repoId ?? "local"}
            auth={auth}
            access={access}
            repoId={repoId}
            repoMode={repos.find((repo) => repo.repoId === repoId)?.mode}
          />
        ) : tab === "devices" ? (
          <DevicesTab access={access} />
        ) : tab === "teams" ? (
          <TeamsTab access={access} />
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
