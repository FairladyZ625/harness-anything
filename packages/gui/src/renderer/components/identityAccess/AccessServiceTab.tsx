import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  AccessAdminApi,
  AccessRejection,
  AccessSessionLifetimeReply,
} from "../../../api/access-admin-contract.ts";
import type { OidcAuthApi } from "../../../api/oidc-auth-contract.ts";
import { isRejection } from "../../access-model.ts";
import { t } from "../../i18n/index.tsx";
import { BrowserView } from "../../views/BrowserView.tsx";
import { DenseRow } from "../primitives/DenseRow.tsx";
import { Region } from "../primitives/Region.tsx";
import { BoardColumn, BoardMain, BoardRegion, BoardSide, RegionBoard } from "../primitives/RegionBoard.tsx";
import { StatusTag } from "../primitives/StatusTag.tsx";
import { Button } from "../primitives/Button.tsx";
import { AccessNotice, INPUT, asRejection, useAccessRead } from "./AccessParts.tsx";

type RecordValue = Record<string, unknown>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Who is signed in and which Keycloak carries authorization: Harness-managed or external, where it
 * is, whether it answers. The native administration console opens in the system browser.
 */
export function AccessServiceTab({
  auth,
  access,
  repoId,
}: {
  readonly auth: OidcAuthApi;
  readonly repoId?: string;
  readonly access: AccessAdminApi | undefined;
}) {
  const [session, setSession] = useState<RecordValue | null>(null),
    [binding, setBinding] = useState<RecordValue | null | undefined>(undefined),
    [bootstrapRequired, setBootstrapRequired] = useState(false),
    [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState("");
  const [login, setLogin] = useState<{ url?: string } | null>(null);
  const loggingIn = useRef(false);
  useEffect(
    () => () => {
      if (loggingIn.current) void auth.cancelLogin();
    },
    [auth],
  );

  const refresh = async () => {
    const nextSession = await auth.status(repoId);
    setSession(nextSession as RecordValue);
    const nextBinding = (await auth.bindingStatus(repoId)) as RecordValue;
    if (nextBinding.configured === false) {
      setBinding(null);
      setBootstrapRequired(false);
      return;
    }
    setBinding(nextBinding);
    const bootstrap = (await auth.bootstrapStatus(repoId)) as RecordValue;
    setBootstrapRequired(bootstrap.required === true);
  };

  useEffect(() => {
    void refresh().catch((error: unknown) => setFeedback(message(error)));
  }, []);

  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setFeedback("");
    return operation()
      .then(() => {
        window.dispatchEvent(new Event("harness-auth-changed"));
        return refresh();
      })
      .then(
        () => setBusy(false),
        (error: unknown) => {
          setFeedback(message(error));
          setBusy(false);
        },
      );
  };

  const signIn = () =>
    run(async () => {
      loggingIn.current = true;
      setLogin({});
      try {
        await auth.login(repoId, (url) => setLogin({ url }));
      } finally {
        loggingIn.current = false;
        setLogin(null);
      }
    });

  if (login)
    return (
      <section className="flex min-h-0 flex-1 flex-col" data-testid="account-login">
        <header className="flex items-center justify-between gap-2 px-2 py-1">
          <span>{t("identityAccess.signIn")}</span>
          <Button testId="account-login-cancel" onClick={() => void auth.cancelLogin()}>
            {t("identityAccess.cancelLogin")}
          </Button>
        </header>
        {login.url ? (
          <BrowserView initialUrl={login.url} onLoadError={() => void auth.cancelLogin()} />
        ) : (
          <p className="p-2 text-text-muted">{t("identityAccess.loading")}</p>
        )}
      </section>
    );

  const authenticated = session?.authenticated === true,
    ready = binding?.ready === true;
  return (
    <RegionBoard data-testid="access-service-board">
      <BoardMain>
        <BoardColumn>
          {feedback ? (
            <p role="alert" className="border-l-2 border-status-blocked px-3 py-2 text-status-blocked ui-meta">
              {feedback}
            </p>
          ) : null}
          {bootstrapRequired ? (
            <BoardRegion region="bootstrap">
              <BootstrapAdminForm busy={busy} submit={(input) => run(() => auth.bootstrapAdmin(input))} />
            </BoardRegion>
          ) : null}
          <BoardRegion region="service" data-testid="access-service-card">
            <Region
              title={t("accessControl.service.title")}
              tag={
                binding ? (
                  <StatusTag
                    tone={ready ? "done" : "bad"}
                    label={ready ? t("identityAccess.healthy") : t("identityAccess.unavailable")}
                  />
                ) : undefined
              }
              edge={binding && !ready ? "bad" : undefined}
              footer={
                <>
                  <span className="min-w-0 truncate">{t("identityAccess.description")}</span>
                  <span className="ml-auto flex-none">
                    <Button
                      testId="access-open-console"
                      disabled={busy || !ready}
                      onClick={() => void run(() => auth.openConsole(repoId))}
                    >
                      {t("identityAccess.openConsole")}
                    </Button>
                  </span>
                </>
              }
            >
              <DenseRow
                title={t("identityAccess.currentIdentity")}
                time={
                  <span className="flex items-center gap-2.5 font-sans">
                    <span data-testid="identity-session" className="text-text ui-body">
                      {authenticated
                        ? t("identityAccess.signedInAs", { personId: String(session?.personId) })
                        : t("identityAccess.signedOut")}
                    </span>
                    <Button
                      size="sm"
                      disabled={busy || (!authenticated && !ready)}
                      tip={!authenticated && !ready ? t("identityAccess.signInDisabled") : undefined}
                      testId="account-session-action"
                      onClick={() => void (authenticated ? run(() => auth.logout(repoId)) : signIn())}
                    >
                      {authenticated ? t("identityAccess.signOut") : t("identityAccess.signIn")}
                    </Button>
                  </span>
                }
              />
              {binding === null ? (
                <div className="border-t border-border px-3.5 py-2.5 ui-body">
                  <p>{t("identityAccess.unbound")}</p>
                  <p className="text-text-muted">{t("identityAccess.unboundNextStep")}</p>
                </div>
              ) : binding ? (
                <>
                  <DenseRow
                    title={t("identityAccess.mode")}
                    time={t(
                      binding.mode === "managed" ? "accessControl.service.managed" : "accessControl.service.external",
                    )}
                  />
                  <DenseRow title={t("identityAccess.url")} time={String(binding.url ?? "—")} />
                  <DenseRow title={t("identityAccess.realm")} time={String(binding.realm ?? "—")} />
                  <DenseRow
                    title={t("identityAccess.version")}
                    time={String(
                      (binding.versions as RecordValue | undefined)?.keycloak ??
                        binding.version ??
                        t("identityAccess.unknown"),
                    )}
                  />
                </>
              ) : (
                <p className="border-t border-border px-3.5 py-2.5 text-text-muted ui-meta">
                  {t("identityAccess.loading")}
                </p>
              )}
            </Region>
          </BoardRegion>
          {access && authenticated ? (
            <BoardRegion region="lifetime" data-testid="access-session-lifetime">
              <SessionLifetime access={access} />
            </BoardRegion>
          ) : null}
        </BoardColumn>
      </BoardMain>
      {binding !== undefined && binding?.source !== "fleet-center" ? (
        <BoardSide region="binding">
          <Region
            title={t("identityAccess.externalTitle")}
            padded
            footer={
              <span className="ml-auto">
                <Button
                  disabled={busy || binding?.mode === "managed"}
                  onClick={() => void run(() => auth.configure({ mode: "managed" }, repoId))}
                >
                  {t("identityAccess.useManaged")}
                </Button>
              </span>
            }
          >
            <ExternalBindingForm busy={busy} submit={(input) => run(() => auth.configure(input, repoId))} />
          </Region>
        </BoardSide>
      ) : null}
    </RegionBoard>
  );
}

/** How long a signed-in session survives unused. The realm holds the only copy; a change is made against the value read. */
function SessionLifetime({ access }: { readonly access: AccessAdminApi }) {
  const { data, rejection, reload } = useAccessRead<AccessSessionLifetimeReply>(access.sessionLifetime),
    [minutes, setMinutes] = useState(""),
    [busy, setBusy] = useState(false),
    [refusal, setRefusal] = useState<AccessRejection | null>(null);
  useEffect(() => {
    if (data) setMinutes(String(Math.round(data.seconds / 60)));
  }, [data]);
  const save = async () => {
    if (!data) return;
    setBusy(true);
    const reply = await access
      .setSessionLifetime({ sessionLifetimeSeconds: Math.round(Number(minutes) * 60), expectedVersion: data.version })
      .catch(asRejection);
    setRefusal(isRejection(reply) ? reply : null);
    await reload();
    setBusy(false);
  };
  return (
    <Region title={t("accessControl.lifetime.title")} padded>
      {rejection ? (
        <AccessNotice rejection={rejection} testId="access-lifetime-unavailable" />
      ) : data ? (
        <div className="flex flex-col gap-2">
          {refusal && <AccessNotice rejection={refusal} testId="access-lifetime-refusal" />}
          <label className="flex flex-col gap-1 ui-meta text-text-muted">
            {t("accessControl.lifetime.label")}
            <span className="flex flex-wrap items-center gap-2">
              <input
                type="number"
                data-testid="access-lifetime-minutes"
                className={`${INPUT} w-32 font-mono`}
                min={Math.ceil(data.minimumSeconds / 60)}
                max={Math.floor(data.maximumSeconds / 60)}
                value={minutes}
                onChange={(event) => setMinutes(event.currentTarget.value)}
              />
              <Button
                testId="access-lifetime-save"
                disabled={busy || minutes.trim() === "" || Number(minutes) * 60 === data.seconds}
                onClick={() => void save()}
              >
                {t("accessControl.groups.save")}
              </Button>
            </span>
          </label>
          <p className="text-text-faint ui-meta">
            {t("accessControl.lifetime.range", {
              minimum: Math.ceil(data.minimumSeconds / 60),
              maximum: Math.floor(data.maximumSeconds / 60),
            })}
          </p>
        </div>
      ) : (
        <p className="text-text-muted ui-meta">{t("accessControl.loading")}</p>
      )}
    </Region>
  );
}

function ExternalBindingForm({
  busy,
  submit,
}: {
  readonly busy: boolean;
  readonly submit: (input: {
    mode: "external";
    url: string;
    realm: string;
    clientId: string;
    clientSecret: string;
  }) => Promise<void>;
}) {
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const secretInput = event.currentTarget.elements.namedItem("clientSecret") as HTMLInputElement;
    secretInput.value = "";
    void submit({
      mode: "external",
      url: String(data.get("url")),
      realm: String(data.get("realm")),
      clientId: String(data.get("clientId")),
      clientSecret: String(data.get("clientSecret")),
    });
  };
  return (
    <form className="flex flex-col gap-2" onSubmit={onSubmit} data-testid="external-binding-form">
      <p className="text-text-muted ui-meta">{t("identityAccess.externalDescription")}</p>
      <input required name="url" type="url" placeholder={t("identityAccess.urlPlaceholder")} className={INPUT} />
      <input required name="realm" placeholder={t("identityAccess.realm")} className={INPUT} />
      <input
        required
        name="clientId"
        value="harness-center"
        readOnly
        aria-label={t("identityAccess.clientId")}
        className={INPUT}
      />
      <input
        required
        name="clientSecret"
        type="password"
        autoComplete="new-password"
        aria-label={t("identityAccess.clientSecret")}
        placeholder={t("identityAccess.clientSecret")}
        className={INPUT}
      />
      <span className="self-start">
        <Button type="submit" disabled={busy}>
          {t("identityAccess.applyExternal")}
        </Button>
      </span>
    </form>
  );
}

function BootstrapAdminForm({
  busy,
  submit,
}: {
  readonly busy: boolean;
  readonly submit: (input: {
    username: string;
    email: string;
    displayName: string;
    password: string;
    personId: string;
  }) => Promise<void>;
}) {
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget),
      read = (key: string) => String(data.get(key));
    void submit({
      username: read("username"),
      email: read("email"),
      displayName: read("displayName"),
      password: read("password"),
      personId: read("personId"),
    });
  };
  return (
    <Region title={t("identityAccess.bootstrapTitle")} edge="wait" padded>
      <form className="flex flex-col gap-2" onSubmit={onSubmit} data-testid="bootstrap-admin-form">
        <p className="text-text-muted ui-meta">{t("identityAccess.bootstrapDescription")}</p>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-2">
          <input required name="username" placeholder={t("identityAccess.username")} className={INPUT} />
          <input required name="email" type="email" placeholder={t("identityAccess.email")} className={INPUT} />
          <input required name="displayName" placeholder={t("identityAccess.displayName")} className={INPUT} />
          <input required name="personId" placeholder={t("identityAccess.personId")} className={INPUT} />
          <input
            required
            name="password"
            type="password"
            autoComplete="new-password"
            placeholder={t("identityAccess.password")}
            className={INPUT}
          />
        </div>
        <span className="self-start">
          <Button type="submit" disabled={busy}>
            {t("identityAccess.createAdmin")}
          </Button>
        </span>
      </form>
    </Region>
  );
}
