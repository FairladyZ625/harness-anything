import { useEffect, useRef, useState } from "react";
import type { RepoMode } from "../components/RepoModeBadge.tsx";
import { TabPanel } from "../components/primitives/EntryBoundary.tsx";
import { Tabs } from "../components/primitives/Tabs.tsx";
import { IdText } from "../components/IdText.tsx";
import { guiHostBridge } from "../gui-transport.ts";
import { t } from "../i18n/index.tsx";
import type { AuthorizationUiComponents } from "@harness-anything/authorization-gui/ui-component-contract";
import {
  AccessServiceTab,
  DevicesTab,
  GrantsTab,
  PermissionRequestsTab,
  PolicyGroupsTab,
  ReceiptsTab,
  TeamsTab,
} from "../authorization-ui.tsx";

type AccessTab = "devices" | "service" | "teams" | "groups" | "grants" | "requests" | "receipts";

/** The header shows a confirmed account, an explicit unavailable state, or nothing while the read is in flight. */
type CurrentIdentity =
  | { readonly phase: "loading" }
  | { readonly phase: "failed" }
  | { readonly phase: "ready"; readonly authenticated: boolean; readonly personId?: string };

/**
 * Accounts and access control. Every tab is a region board whose ruler is the tab panel: at 900px
 * and wider the board fills the height under the tab bar and regions scroll inside themselves;
 * narrower, it stacks into one column and the panel scrolls.
 */
export function IdentityAccessView({
  repos = [],
  repoId,
  rootDir,
  components,
}: {
  readonly repoId?: string;
  readonly rootDir?: string;
  readonly components?: AuthorizationUiComponents;
  readonly repos?: readonly {
    readonly repoId: string;
    readonly displayName: string;
    readonly mode?: RepoMode;
  }[];
}) {
  const bridge = guiHostBridge(),
    ui = components ?? bridge?.authorizationUi,
    auth = bridge?.auth && typeof bridge.auth.status === "function" ? bridge.auth : undefined,
    access = bridge?.access?.forRepository(repoId),
    [tab, setTab] = useState<AccessTab>("grants");

  const [identity, setIdentity] = useState<CurrentIdentity>({ phase: "loading" }),
    identityRequest = useRef(0);
  useEffect(() => {
    setIdentity({ phase: "loading" });
    const refreshIdentity = () => {
      if (!auth) return;
      const request = ++identityRequest.current;
      void auth.status(repoId, rootDir).then(
        (reply) => {
          // A read that started before the repository changed must not restore its person.
          if (identityRequest.current !== request) return;
          const status = reply as { readonly authenticated?: boolean; readonly personId?: string };
          setIdentity({
            phase: "ready",
            authenticated: status.authenticated === true,
            ...(status.personId ? { personId: status.personId } : {}),
          });
        },
        () => {
          // A failed read invalidates the previous account; the page says "unavailable" instead of
          // keeping a stale person or pretending the session was signed out.
          if (identityRequest.current !== request) return;
          setIdentity({ phase: "failed" });
        },
      );
    };
    refreshIdentity();
    window.addEventListener("harness-auth-changed", refreshIdentity);
    return () => {
      identityRequest.current += 1;
      window.removeEventListener("harness-auth-changed", refreshIdentity);
    };
  }, [auth, repoId, rootDir]);
  if (!auth) return <p role="alert">{t("identityAccess.electronOnly")}</p>;
  const identityText =
      identity.phase === "failed"
        ? t("identityAccess.identityUnavailable")
        : identity.phase === "ready"
          ? identity.authenticated
            ? (identity.personId ?? "")
            : t("identityAccess.signedOut")
          : "",
    identityPersonId = identity.phase === "ready" && identity.authenticated ? (identity.personId ?? "") : "";
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="identity-access-view">
      <header className="flex flex-wrap items-baseline gap-3 px-5 py-3">
        <h1 className="text-xl font-semibold text-text">{t("identityAccess.title")}</h1>
        {ui?.UserIdentity ? (
          <ui.UserIdentity personId={identityText} />
        ) : (
          <span data-testid="access-current-account" className="ui-body">
            {t("accessControl.members.identity")}: <IdText value={identityText} className="text-text" />
          </span>
        )}
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
                  { key: "requests" as const, label: t("accessControl.requests.tab") },
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
          ui?.Login ? (
            <ui.Login auth={auth} repoId={repoId} rootDir={rootDir} />
          ) : (
            <AccessServiceTab
              key={repoId ?? "local"}
              auth={auth}
              access={access}
              repoId={repoId}
              rootDir={rootDir}
              repoMode={repos.find((repo) => repo.repoId === repoId)?.mode}
            />
          )
        ) : ui?.AccessControl ? (
          <ui.AccessControl auth={auth} access={access} repoId={repoId} rootDir={rootDir} repositories={repos} />
        ) : tab === "devices" ? (
          <DevicesTab access={access} auth={auth} repoId={repoId} rootDir={rootDir} />
        ) : tab === "teams" ? (
          <TeamsTab access={access} />
        ) : tab === "groups" ? (
          <PolicyGroupsTab access={access} />
        ) : tab === "grants" ? (
          <GrantsTab access={access} repos={repos} />
        ) : tab === "requests" ? (
          <PermissionRequestsTab access={access} identity={identityPersonId} />
        ) : (
          <ReceiptsTab access={access} />
        )}
      </TabPanel>
    </div>
  );
}
