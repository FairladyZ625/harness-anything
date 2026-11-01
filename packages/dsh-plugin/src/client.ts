import { createElement, type ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { SidebarPanelIconOwnerProps } from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type { BrokerFailure, BrokerResponse } from "./shared.ts";
import { BROKER_ROUTE } from "./shared.ts";

const PANEL_ID = "harness-anything";
const LOCALE_NAMESPACE = "harnessAnything";

interface ClientContext extends Context {
  readonly locale: {
    register(namespace: string, messages: Record<string, Record<string, string>>): () => void;
    bind(namespace: string): (key: string) => string;
  };
  readonly slots: {
    inject(name: string, factory: () => () => void): () => void;
    register(options: Record<string, unknown>, component: (props: never) => ReactNode): () => void;
  };
  readonly effect: (factory: () => void | (() => void), label?: string) => unknown;
  readonly sidebarRight: {
    openTab(kind: string, options: { readonly params: { readonly url: string } }): void;
  };
  readonly layout: {
    selectPanel(panelId: string | null): void;
  };
  readonly logger: {
    info(message: string, ...args: readonly unknown[]): void;
    warn(message: string, ...args: readonly unknown[]): void;
  };
}

function waitForSessionMount(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(() => resolve());
      return;
    }
    queueMicrotask(resolve);
  });
}

export class BrokerClientError extends Error {
  readonly code: string;
  readonly hint: string;

  constructor(failure: BrokerFailure) {
    super(`${failure.error.code}: ${failure.error.hint}`);
    this.name = "BrokerClientError";
    this.code = failure.error.code;
    this.hint = failure.error.hint;
  }
}

interface ObservableSnapshot<T> {
  readonly getSnapshot: () => T;
  readonly subscribe: (listener: () => void) => () => void;
}

interface SnapshotStore<T> extends ObservableSnapshot<T> {
  readonly set: (next: T) => void;
}

/** Small browser-safe store matching DSH's ObservableSnapshot contract. */
function createSnapshotStore<T>(initial: T): SnapshotStore<T> {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next) => {
      snapshot = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

const messages = {
  en: {
    panel: "Harness Anything",
    title: "Harness Anything in DeepSeek Harness",
    open: "Open Harness panel",
  },
  zh: {
    panel: "Harness Anything",
    title: "在 DeepSeek Harness 中使用 Harness Anything",
    open: "打开 Harness 面板",
  },
};

function isBrokerResponse(value: unknown): value is BrokerResponse {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.ok === true) return typeof record.url === "string" && record.url.length > 0;
  const error = record.error;
  return (
    record.ok === false &&
    !!error &&
    typeof error === "object" &&
    typeof (error as Record<string, unknown>).code === "string" &&
    typeof (error as Record<string, unknown>).hint === "string"
  );
}

/** Fetch the Host-owned broker URL and open DSH's built-in browser tab. */
export async function openHarnessBrowser(ctx: ClientContext, fetcher: typeof fetch = fetch): Promise<BrokerResponse> {
  const response = await fetcher(BROKER_ROUTE, { headers: { accept: "application/json" } });
  const value: unknown = await response.json();
  if (!isBrokerResponse(value)) throw new Error("Harness Anything broker returned an invalid response.");
  if (!value.ok) throw new BrokerClientError(value);
  // Sidebar-right is session-scoped. Returning from this plugin's global main
  // panel needs one browser turn for the session seat to mount before opening.
  ctx.layout.selectPanel(null);
  await waitForSessionMount();
  ctx.sidebarRight.openTab("browser", { params: { url: value.url } });
  return value;
}

function failureDetails(error: unknown): { readonly code: string; readonly hint: string } {
  if (error instanceof BrokerClientError) return { code: error.code, hint: error.hint };
  if (error instanceof Error) return { code: "broker_unavailable", hint: error.message };
  return { code: "broker_unavailable", hint: String(error) };
}

interface BrokerFailureDetails {
  readonly code: string;
  readonly hint: string;
}

interface BrokerFailureNoticeInjected {
  readonly hooks: { readonly failure: ObservableSnapshot<BrokerFailureDetails | null> };
  readonly dismiss: () => void;
}

interface BrokerFailureNoticeProps {
  readonly useFailure: <T>(selector: (value: BrokerFailureDetails | null) => T) => T;
  readonly dismiss: () => void;
}

function BrokerFailureNotice({ useFailure, dismiss }: BrokerFailureNoticeProps): ReactNode {
  const failure = useFailure((value) => value);
  if (failure === null) return null;
  return createElement(
    "div",
    {
      role: "alert",
      style: {
        pointerEvents: "auto",
        margin: 16,
        maxWidth: 560,
        padding: "12px 16px",
        border: "1px solid #a05252",
        background: "#f1dddd",
        color: "#5a2929",
        boxShadow: "0 4px 16px rgba(61, 56, 51, .18)",
      },
    },
    createElement("strong", null, "Harness panel unavailable / Harness 面板不可用"),
    createElement("p", { style: { margin: "6px 0" } }, `${failure.code}: ${failure.hint}`),
    createElement("button", { type: "button", onClick: dismiss }, "Dismiss / 关闭"),
  );
}

function reportOpenFailure(
  ctx: ClientContext,
  store: SnapshotStore<BrokerFailureDetails | null>,
  error: unknown,
): void {
  const details = failureDetails(error);
  ctx.logger.warn("harness-anything: broker unavailable (%s)", `${details.code}: ${details.hint}`);
  store.set(details);
}

function HarnessIcon({ size }: PropsRuntime<"sidebar.panellist"> & SidebarPanelIconOwnerProps): ReactNode {
  return createElement(
    "span",
    {
      title: "Harness Anything",
      style: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        fontSize: Math.max(9, size - 6),
        fontWeight: 700,
      },
      "aria-hidden": true,
    },
    "HA",
  );
}

function Tutorial({
  ctx,
  t,
  reportFailure,
}: {
  readonly ctx: ClientContext;
  readonly t: (key: string) => string;
  readonly reportFailure: (error: unknown) => void;
}): ReactNode {
  return createElement(
    "article",
    { style: { maxWidth: 720, padding: 32, lineHeight: 1.6 } },
    createElement("h1", null, t("title")),
    createElement("p", null, "macOS desktop only / 仅支持 macOS 桌面端。"),
    createElement(
      "ol",
      null,
      createElement(
        "li",
        null,
        "Install the ha CLI and run `ha init` in your repository. / 安装 ha CLI，并在仓库中运行 `ha init`。",
      ),
      createElement(
        "li",
        null,
        "Switch the DSH session to full permissions so bash can run ha. / 将 DSH 会话权限切到完全权限，bash 才能运行 ha。",
      ),
      createElement(
        "li",
        null,
        "Choose the ha-ceo preset and start work with the harness-ceo skill. / 选择 ha-ceo preset，用 harness-ceo skill 发起工作。",
      ),
      createElement(
        "li",
        null,
        "Use the Harness panel below to inspect the board. / 使用下面的按钮打开 Harness 面板看板。",
      ),
    ),
    createElement(
      "button",
      {
        type: "button",
        onClick: () => {
          void openHarnessBrowser(ctx).catch(reportFailure);
        },
      },
      t("open"),
    ),
    createElement(
      "p",
      null,
      "一期限制：实时流、终端和原生文件在 DSH 插件内嵌形态中不可用，这是内嵌形态本身的限制，不是 Harness 的限制。需要完整功能时，请在终端运行 `ha gui` 打开 Harness 原生桌面 GUI；它与面板看到的是同一份台账，可以同时开着。 / First-release limitation: live streams, terminals, and native files are unavailable in the DSH plugin's embedded form. This is a limitation of the embedded form, not of Harness. For the complete experience, run `ha gui` in a terminal to open the native Harness desktop GUI. It shows the same ledger as the panel, so both can stay open together.",
    ),
  );
}

export const inject = ["slots", "locale", "sidebarRight", "layout"];

export function apply(ctx: ClientContext): void {
  const failure = createSnapshotStore<BrokerFailureDetails | null>(null);
  const reportFailure = (error: unknown): void => reportOpenFailure(ctx, failure, error);
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, messages), "harness-anything: dictionaries");
  ctx.effect(() => () => failure.set(null), "harness-anything: broker error notice");
  const t = ctx.locale.bind(LOCALE_NAMESPACE);
  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register(
      {
        name: "shell.overlay",
        id: "harness-anything.broker-error",
        order: 100,
        inject: (): BrokerFailureNoticeInjected => ({ hooks: { failure }, dismiss: () => failure.set(null) }),
      },
      BrokerFailureNotice as (props: never) => ReactNode,
    ),
  );
  ctx.slots.inject("main", () =>
    ctx.slots.register({ name: "main", key: PANEL_ID, locale: LOCALE_NAMESPACE }, (() =>
      Tutorial({ ctx, t, reportFailure })) as (props: never) => ReactNode),
  );
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      { name: "sidebar.panellist", id: PANEL_ID, order: 25, label: () => t("panel"), locale: LOCALE_NAMESPACE },
      ((props: PropsRuntime<"sidebar.panellist">) => HarnessIcon(props)) as (props: never) => ReactNode,
    ),
  );
}
