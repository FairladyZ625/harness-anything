import { createElement, useEffect, useState, type ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { SidebarPanelIconOwnerProps } from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type { BrokerFailure, BrokerResponse } from "./shared.ts";
import { BROKER_ROUTE } from "./shared.ts";
import { tutorialCopy, type TutorialCopy } from "./tutorial-content.ts";
import { Tutorial } from "./tutorial.ts";

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

/** About two seconds of rendered frames. */
const SESSION_MOUNT_FRAMES = 120;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof globalThis.requestAnimationFrame === "function") globalThis.requestAnimationFrame(() => resolve());
    else queueMicrotask(resolve);
  });
}

function consumeKnownError(error: unknown): void {
  if (!(error instanceof Error) || error.message !== "no session surface is mounted") throw error;
}

/**
 * Sidebar-right is session-scoped: after `selectPanel(null)` the session seat
 * mounts on a later render, and openTab throws until it has. DSH exposes no
 * mount event, so retry once per rendered frame.
 */
async function openTabWhenSessionMounts(ctx: ClientContext, url: string): Promise<void> {
  for (let frame = 0; ; frame += 1) {
    try {
      ctx.sidebarRight.openTab("browser", { params: { url } });
      return;
    } catch (error) {
      consumeKnownError(error);
      if (frame >= SESSION_MOUNT_FRAMES) throw error;
      await nextFrame();
    }
  }
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
  en: { panel: "Harness Anything", language: "en" },
  zh: { panel: "Harness Anything", language: "zh" },
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
async function fetchHarnessBroker(fetcher: typeof fetch = fetch): Promise<Extract<BrokerResponse, { ok: true }>> {
  const response = await fetcher(BROKER_ROUTE, { headers: { accept: "application/json" } });
  const value: unknown = await response.json();
  if (!isBrokerResponse(value)) throw new Error("Harness Anything broker returned an invalid response.");
  if (!value.ok) throw new BrokerClientError(value);
  return value;
}

export async function openHarnessBrowser(ctx: ClientContext, fetcher: typeof fetch = fetch): Promise<BrokerResponse> {
  const value = await fetchHarnessBroker(fetcher);
  ctx.layout.selectPanel(null);
  await openTabWhenSessionMounts(ctx, value.url);
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

const panelStyle = `
.ha-panel{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}
.ha-panel-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:calc(var(--dsh-frame-top-clearance, 0px) + 8px) 16px 8px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.ha-panel-tabs{display:flex;gap:4px;margin-right:auto}
.ha-panel-bar button,.ha-panel-status button{font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:6px 12px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary)}
.ha-panel-tabs button[aria-selected=true]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}
.ha-panel-body{flex:1;min-height:0;overflow:auto;--dsh-frame-top-clearance:0px}
.ha-panel-body[hidden]{display:none}
.ha-panel-embed{position:relative;display:flex;flex-direction:column;overflow:hidden}
.ha-panel-embed iframe{width:100%;flex:1;min-height:0;border:0;background:var(--dsw-alias-bg-base)}
.ha-panel-status{padding:16px;color:var(--dsw-alias-label-secondary)}
`;

/** The Host owns the process; hiding a tab keeps its iframe and in-frame state alive. */
export function HarnessPanel({
  copy,
  onOpen,
}: {
  readonly copy: TutorialCopy;
  readonly onOpen: () => void;
}): ReactNode {
  const [tab, setTab] = useState<"tutorial" | "harness">("tutorial");
  const [retry, setRetry] = useState(0);
  const [broker, setBroker] = useState<{ readonly url: string; readonly error: BrokerFailureDetails | null }>({
    url: "",
    error: null,
  });
  useEffect(() => {
    if (tab !== "harness") return;
    let current = true;
    void fetchHarnessBroker().then(
      (value) => {
        if (current) setBroker({ url: value.url, error: null });
      },
      (error: unknown) => {
        if (current) setBroker({ url: "", error: failureDetails(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [tab, retry]);
  const tabButton = (value: "tutorial" | "harness", label: string): ReactNode =>
    createElement(
      "button",
      {
        type: "button",
        role: "tab",
        id: `ha-tab-${value}`,
        "aria-controls": `ha-page-${value}`,
        "aria-selected": tab === value,
        tabIndex: tab === value ? 0 : -1,
        onClick: () => setTab(value),
        onKeyDown: (event: import("react").KeyboardEvent<HTMLButtonElement>) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next =
            event.key === "Home"
              ? "tutorial"
              : event.key === "End"
                ? "harness"
                : value === "tutorial"
                  ? "harness"
                  : "tutorial";
          setTab(next);
          event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#ha-tab-${next}`)?.focus();
        },
      },
      label,
    );
  return createElement(
    "div",
    { className: "ha-panel", "data-testid": "harness-main-panel" },
    createElement("style", null, panelStyle),
    createElement(
      "div",
      { className: "ha-panel-bar" },
      createElement(
        "div",
        { role: "tablist", "aria-label": "Harness", className: "ha-panel-tabs" },
        tabButton("tutorial", "教程"),
        tabButton("harness", "Harness"),
      ),
      createElement("button", { type: "button", onClick: onOpen }, "在内置浏览器打开"),
    ),
    createElement(
      "div",
      {
        className: "ha-panel-body",
        role: "tabpanel",
        id: "ha-page-tutorial",
        "aria-labelledby": "ha-tab-tutorial",
        hidden: tab !== "tutorial",
      },
      createElement(Tutorial, { copy, onOpen }),
    ),
    createElement(
      "div",
      {
        className: "ha-panel-body ha-panel-embed",
        role: "tabpanel",
        id: "ha-page-harness",
        "aria-labelledby": "ha-tab-harness",
        hidden: tab !== "harness",
      },
      broker.error
        ? createElement(
            "div",
            { role: "alert", className: "ha-panel-status" },
            createElement("p", null, `${broker.error.code}: ${broker.error.hint}`),
            createElement("button", { type: "button", onClick: () => setRetry((value) => value + 1) }, "重试"),
          )
        : !broker.url
          ? createElement("div", { role: "status", className: "ha-panel-status" }, "正在打开 Harness…")
          : null,
      broker.url
        ? createElement("iframe", { src: broker.url, title: "Harness GUI", referrerPolicy: "no-referrer" })
        : null,
    ),
  );
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
      createElement(HarnessPanel, {
        copy: t("language") === "zh" ? tutorialCopy.zh : tutorialCopy.en,
        onOpen: () => {
          void openHarnessBrowser(ctx).catch(reportFailure);
        },
      })) as (props: never) => ReactNode),
  );
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      { name: "sidebar.panellist", id: PANEL_ID, order: 25, label: () => t("panel"), locale: LOCALE_NAMESPACE },
      ((props: PropsRuntime<"sidebar.panellist">) => HarnessIcon(props)) as (props: never) => ReactNode,
    ),
  );
}
