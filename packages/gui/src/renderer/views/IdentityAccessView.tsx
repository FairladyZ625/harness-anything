import { useEffect, useState, type FormEvent } from "react";
import { guiHostBridge } from "../gui-transport.ts";
import { t } from "../i18n/index.tsx";

type RecordValue = Record<string, unknown>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function IdentityAccessView() {
  const authCandidate = guiHostBridge()?.auth,
    auth = authCandidate && typeof authCandidate.status === "function" ? authCandidate : undefined,
    [session, setSession] = useState<RecordValue | null>(null),
    [binding, setBinding] = useState<RecordValue | null | undefined>(undefined),
    [bootstrapRequired, setBootstrapRequired] = useState(false),
    [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState("");

  const refresh = async () => {
    if (!auth) return;
    const nextSession = await auth.status();
    setSession(nextSession as RecordValue);
    const nextBinding = (await auth.bindingStatus()) as RecordValue;
    if (nextBinding.configured === false) {
      setBinding(null);
      setBootstrapRequired(false);
      return;
    }
    setBinding(nextBinding);
    if (nextBinding && (nextBinding as RecordValue).mode === "managed") {
      const bootstrap = (await auth.bootstrapStatus()) as RecordValue;
      setBootstrapRequired(bootstrap.required === true);
    } else {
      setBootstrapRequired(false);
    }
  };

  useEffect(() => {
    void refresh().catch((error: unknown) => setFeedback(message(error)));
  }, []);

  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setFeedback("");
    return operation()
      .then(refresh)
      .then(
        () => setBusy(false),
        (error: unknown) => {
          setFeedback(message(error));
          setBusy(false);
        },
      );
  };

  if (!auth) return <p role="alert">{t("identityAccess.electronOnly")}</p>;
  const authenticated = session?.authenticated === true;
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6" data-testid="identity-access-view">
      <header>
        <h1 className="text-xl font-semibold">{t("identityAccess.title")}</h1>
        <p className="text-sm text-text-muted">{t("identityAccess.description")}</p>
      </header>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="font-semibold">{t("identityAccess.currentIdentity")}</h2>
        <p data-testid="identity-session" className="mt-2 text-sm">
          {authenticated
            ? t("identityAccess.signedInAs", { personId: String(session?.personId) })
            : t("identityAccess.signedOut")}
        </p>
        <button
          className="mt-3 rounded border border-border px-3 py-1.5"
          disabled={busy || (!authenticated && binding?.ready !== true)}
          title={!authenticated && binding?.ready !== true ? t("identityAccess.signInDisabled") : undefined}
          onClick={() => void run(authenticated ? auth.logout : auth.login)}
        >
          {authenticated ? t("identityAccess.signOut") : t("identityAccess.signIn")}
        </button>
      </section>

      {bootstrapRequired ? (
        <BootstrapAdminForm busy={busy} submit={(input) => run(() => auth.bootstrapAdmin(input))} />
      ) : null}

      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">{t("identityAccess.bindingTitle")}</h2>
            {binding === null ? (
              <div className="mt-2 text-sm">
                <p>{t("identityAccess.unbound")}</p>
                <p className="text-text-muted">{t("identityAccess.unboundNextStep")}</p>
              </div>
            ) : binding ? (
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt>{t("identityAccess.mode")}</dt>
                <dd>{String(binding?.mode ?? "—")}</dd>
                <dt>{t("identityAccess.url")}</dt>
                <dd>{String(binding?.url ?? "—")}</dd>
                <dt>{t("identityAccess.realm")}</dt>
                <dd>{String(binding?.realm ?? "—")}</dd>
                <dt>{t("identityAccess.health")}</dt>
                <dd>{binding?.ready === true ? t("identityAccess.healthy") : t("identityAccess.unavailable")}</dd>
                <dt>{t("identityAccess.version")}</dt>
                <dd>
                  {String(
                    (binding?.versions as RecordValue | undefined)?.keycloak ??
                      binding?.version ??
                      t("identityAccess.unknown"),
                  )}
                </dd>
              </dl>
            ) : (
              <p className="mt-2 text-sm text-text-muted">{t("identityAccess.loading")}</p>
            )}
          </div>
          <button
            className="rounded border border-border px-3 py-1.5"
            disabled={busy || binding?.ready !== true}
            onClick={() => void run(auth.openConsole)}
          >
            {t("identityAccess.openConsole")}
          </button>
        </div>
      </section>

      <ExternalBindingForm busy={busy} submit={(input) => run(() => auth.configure(input))} />
      <button
        disabled={busy || binding?.mode === "managed"}
        className="self-start rounded border border-border px-3 py-1.5"
        onClick={() => void run(() => auth.configure({ mode: "managed" }))}
      >
        {t("identityAccess.useManaged")}
      </button>
      {feedback ? (
        <p role="alert" className="text-sm text-danger">
          {feedback}
        </p>
      ) : null}
    </div>
  );
}

function ExternalBindingForm({
  busy,
  submit,
}: {
  readonly busy: boolean;
  readonly submit: (input: { mode: "external"; url: string; realm: string; clientId: string }) => Promise<void>;
}) {
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void submit({
      mode: "external",
      url: String(data.get("url")),
      realm: String(data.get("realm")),
      clientId: String(data.get("clientId")),
    });
  };
  return (
    <form className="rounded-lg border border-border bg-surface p-4" onSubmit={onSubmit}>
      <h2 className="font-semibold">{t("identityAccess.externalTitle")}</h2>
      <p className="mt-1 text-sm text-text-muted">{t("identityAccess.externalDescription")}</p>
      <div className="mt-3 grid gap-2 md:grid-cols-3">
        <input
          required
          name="url"
          type="url"
          placeholder={t("identityAccess.urlPlaceholder")}
          className="rounded border border-border bg-bg px-2 py-1.5"
        />
        <input
          required
          name="realm"
          placeholder={t("identityAccess.realm")}
          className="rounded border border-border bg-bg px-2 py-1.5"
        />
        <input
          required
          name="clientId"
          placeholder={t("identityAccess.clientId")}
          className="rounded border border-border bg-bg px-2 py-1.5"
        />
      </div>
      <button disabled={busy} className="mt-3 rounded border border-border px-3 py-1.5">
        {t("identityAccess.applyExternal")}
      </button>
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
    <form
      className="rounded-lg border border-border-strong bg-surface p-4"
      onSubmit={onSubmit}
      data-testid="bootstrap-admin-form"
    >
      <h2 className="font-semibold">{t("identityAccess.bootstrapTitle")}</h2>
      <p className="mt-1 text-sm text-text-muted">{t("identityAccess.bootstrapDescription")}</p>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <input
          required
          name="username"
          placeholder={t("identityAccess.username")}
          className="rounded border border-border bg-bg px-2 py-1.5"
        />
        <input
          required
          name="email"
          type="email"
          placeholder={t("identityAccess.email")}
          className="rounded border border-border bg-bg px-2 py-1.5"
        />
        <input
          required
          name="displayName"
          placeholder={t("identityAccess.displayName")}
          className="rounded border border-border bg-bg px-2 py-1.5"
        />
        <input
          required
          name="personId"
          placeholder={t("identityAccess.personId")}
          className="rounded border border-border bg-bg px-2 py-1.5"
        />
        <input
          required
          name="password"
          type="password"
          autoComplete="new-password"
          placeholder={t("identityAccess.password")}
          className="rounded border border-border bg-bg px-2 py-1.5 md:col-span-2"
        />
      </div>
      <button disabled={busy} className="mt-3 rounded border border-border px-3 py-1.5">
        {t("identityAccess.createAdmin")}
      </button>
    </form>
  );
}
