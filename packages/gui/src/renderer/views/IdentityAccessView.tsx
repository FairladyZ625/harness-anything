import { useEffect, useRef, useState } from "react";
import type { RepoMode } from "../components/RepoModeBadge.tsx";
import { Button } from "../components/primitives/Button.tsx";
import { TabPanel } from "../components/primitives/EntryBoundary.tsx";
import { Tabs } from "../components/primitives/Tabs.tsx";
import { IdText } from "../components/IdText.tsx";
import { guiHostBridge } from "../gui-transport.ts";
import { t } from "../i18n/index.tsx";
import type { AuthorizationUiComponents } from "@harness-anything/authorization-gui/ui-component-contract";
import type { IdentityProvider } from "@harness-anything/authorization-gui/identity-presentation";
import { readIdentity, type IdentitySnapshot } from "../identity-session.ts";
import { consumeAccountLoginRequest, subscribeAccountLoginRequest } from "../account-login-request.ts";
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
type CurrentIdentity = { readonly phase: "loading" } | IdentitySnapshot;

function providerLabel(provider: IdentityProvider): string {
  return provider === "builtin"
    ? t("identityAccess.localIdentity")
    : provider === "keycloak"
      ? t("identityAccess.keycloakIdentity")
      : "";
}

function signInLabel(provider: IdentityProvider): string {
  return provider === "builtin"
    ? t("identityAccess.localSignIn")
    : provider === "keycloak"
      ? t("identityAccess.signIn")
      : t("identityAccess.signInNeutral");
}

/**
 * Accounts and access control. Every tab is a region board whose ruler is the tab panel: at 900px
 * and wider the board fills the height under the tab bar and regions scroll inside themselves;
 * narrower, it stacks into one column and the panel scrolls.
 *
 * A signed-out or unreadable identity lands on the service tab, which owns the one sign-in surface;
 * a confirmed account keeps the grants landing. The header repeats the state and, when signed out,
 * carries the same sign-in action rather than a second login implementation.
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
    [tab, setTab] = useState<AccessTab>("grants"),
    [autoLogin, setAutoLogin] = useState(false);

  const [identity, setIdentity] = useState<CurrentIdentity>({ phase: "loading" }),
    identityRequest = useRef(0);
  useEffect(() => {
    setIdentity({ phase: "loading" });
    const refreshIdentity = () => {
      if (!auth) return;
      const request = ++identityRequest.current;
      void readIdentity(auth, repoId, rootDir).then((snapshot) => {
        // A read that started before the repository changed must not restore its person.
        if (identityRequest.current !== request) return;
        setIdentity(snapshot);
      });
    };
    refreshIdentity();
    window.addEventListener("harness-auth-changed", refreshIdentity);
    return () => {
      identityRequest.current += 1;
      window.removeEventListener("harness-auth-changed", refreshIdentity);
    };
  }, [auth, repoId, rootDir]);

  // A business read that needs authentication or the error surface's sign-in action requests the
  // account surface; the same request starts the service tab's existing login flow once it mounts.
  useEffect(() => {
    const consume = () => {
      if (!consumeAccountLoginRequest()) return;
      // The login flow lives in the service tab; selecting it is part of honouring the request,
      // including when the person had moved to another tab after signing out.
      setTab("service");
      setAutoLogin(true);
    };
    consume();
    return subscribeAccountLoginRequest(consume);
  }, []);

  const signedOut = identity.phase === "ready" && !identity.authenticated,
    needsSignInLanding = identity.phase === "unavailable" || signedOut;
  // Land on the tab that owns sign-in when the account is gone or unreadable; a later tab choice
  // stays the person's choice until the state changes again.
  useEffect(() => {
    if (needsSignInLanding) setTab("service");
  }, [needsSignInLanding]);

  if (!auth) return <p role="alert">{t("identityAccess.electronOnly")}</p>;
  const identityText =
      identity.phase === "unavailable"
        ? t("identityAccess.identityUnavailable")
        : identity.phase === "ready"
          ? identity.authenticated
            ? identity.personId
            : t("identityAccess.signedOut")
          : "",
    identityProvider = identity.phase === "loading" ? "unknown" : identity.provider,
    identityPersonId = identity.phase === "ready" && identity.authenticated ? identity.personId : "",
    builtInLogin = ui?.Login === undefined,
    loginLabel = signInLabel(identityProvider);
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
        {identityProvider !== "unknown" && (
          <span data-testid="access-current-provider" className="ui-meta text-text-muted">
            {providerLabel(identityProvider)}
          </span>
        )}
        {identity.phase === "unavailable" && (
          <span data-testid="access-identity-unavailable-hint" className="ui-meta text-text-muted">
            {t("identityAccess.identityUnavailableHint")}
          </span>
        )}
        <span className="min-w-0 truncate text-sm text-text-muted">{t("accessControl.tagline")}</span>
        {signedOut && builtInLogin && identityProvider !== "unknown" ? (
          <span className="ml-auto">
            <Button
              variant="primary"
              testId="account-header-sign-in"
              onClick={() => {
                setTab("service");
                setAutoLogin(true);
              }}
            >
              {loginLabel}
            </Button>
          </span>
        ) : null}
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
              autoLogin={autoLogin}
              onAutoLoginConsumed={() => setAutoLogin(false)}
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
