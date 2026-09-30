import { useEffect, useState, type FormEvent } from "react";
import { guiHostBridge } from "../gui-transport.ts";

type RecordValue = Record<string, unknown>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function IdentityAccessView() {
  const authCandidate = guiHostBridge()?.auth,
    auth = authCandidate && typeof authCandidate.status === "function" ? authCandidate : undefined,
    [session, setSession] = useState<RecordValue | null>(null),
    [binding, setBinding] = useState<RecordValue | null>(null),
    [bootstrapRequired, setBootstrapRequired] = useState(false),
    [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState("");

  const refresh = async () => {
    if (!auth) return;
    const [nextSession, nextBinding] = await Promise.all([auth.status(), auth.bindingStatus()]);
    setSession(nextSession as RecordValue);
    setBinding(nextBinding as RecordValue);
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

  if (!auth) return <p role="alert">身份管理仅在 Electron 桌面应用中可用。</p>;
  const authenticated = session?.authenticated === true;
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6" data-testid="identity-access-view">
      <header>
        <h1 className="text-xl font-semibold">身份与存取</h1>
        <p className="text-sm text-text-muted">Keycloak 是账号、凭据与授权的运行权威。</p>
      </header>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="font-semibold">当前身份</h2>
        <p data-testid="identity-session" className="mt-2 text-sm">
          {authenticated ? `已登入 · ${String(session?.personId)}` : "尚未登入"}
        </p>
        <button
          className="mt-3 rounded border border-border px-3 py-1.5"
          disabled={busy}
          onClick={() => void run(authenticated ? auth.logout : auth.login)}
        >
          {authenticated ? "登出" : "使用 Keycloak 登入"}
        </button>
      </section>

      {bootstrapRequired ? (
        <BootstrapAdminForm busy={busy} submit={(input) => run(() => auth.bootstrapAdmin(input))} />
      ) : null}

      <section className="rounded-lg border border-border bg-surface p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">Keycloak 綁定</h2>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt>模式</dt>
              <dd>{String(binding?.mode ?? "—")}</dd>
              <dt>URL</dt>
              <dd>{String(binding?.url ?? "—")}</dd>
              <dt>Realm</dt>
              <dd>{String(binding?.realm ?? "—")}</dd>
              <dt>健康</dt>
              <dd>{binding?.ready === true ? "正常" : "不可用"}</dd>
              <dt>版本</dt>
              <dd>{String((binding?.versions as RecordValue | undefined)?.keycloak ?? binding?.version ?? "未知")}</dd>
            </dl>
          </div>
          <button
            className="rounded border border-border px-3 py-1.5"
            disabled={busy || binding?.ready !== true}
            onClick={() => void run(auth.openConsole)}
          >
            在瀏覽器開啟管理控制台
          </button>
        </div>
      </section>

      <ExternalBindingForm busy={busy} submit={(input) => run(() => auth.configure(input))} />
      <button
        disabled={busy || binding?.mode === "managed"}
        className="self-start rounded border border-border px-3 py-1.5"
        onClick={() => void run(() => auth.configure({ mode: "managed" }))}
      >
        切換至 Harness 托管 Keycloak
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
      <h2 className="font-semibold">改接外部 Keycloak</h2>
      <p className="mt-1 text-sm text-text-muted">連線與 realm 探測成功後才會生效。</p>
      <div className="mt-3 grid gap-2 md:grid-cols-3">
        <input
          required
          name="url"
          type="url"
          placeholder="https://identity.example.com"
          className="rounded border border-border bg-bg px-2 py-1.5"
        />
        <input required name="realm" placeholder="Realm" className="rounded border border-border bg-bg px-2 py-1.5" />
        <input
          required
          name="clientId"
          placeholder="Client ID"
          className="rounded border border-border bg-bg px-2 py-1.5"
        />
      </div>
      <button disabled={busy} className="mt-3 rounded border border-border px-3 py-1.5">
        驗證並套用
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
      <h2 className="font-semibold">建立首位管理員</h2>
      <p className="mt-1 text-sm text-text-muted">此 realm 尚無 Harness 管理員；建立成功後本入口永久關閉。</p>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        <input
          required
          name="username"
          placeholder="使用者名稱"
          className="rounded border border-border bg-bg px-2 py-1.5"
        />
        <input
          required
          name="email"
          type="email"
          placeholder="Email"
          className="rounded border border-border bg-bg px-2 py-1.5"
        />
        <input
          required
          name="displayName"
          placeholder="顯示名稱"
          className="rounded border border-border bg-bg px-2 py-1.5"
        />
        <input
          required
          name="personId"
          placeholder="Person ID"
          className="rounded border border-border bg-bg px-2 py-1.5"
        />
        <input
          required
          name="password"
          type="password"
          autoComplete="new-password"
          placeholder="密碼"
          className="rounded border border-border bg-bg px-2 py-1.5 md:col-span-2"
        />
      </div>
      <button disabled={busy} className="mt-3 rounded border border-border px-3 py-1.5">
        建立管理員
      </button>
    </form>
  );
}
