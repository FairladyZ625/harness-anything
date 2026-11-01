import { createElement, type ReactNode } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { SidebarPanelIconOwnerProps } from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type { BrokerResponse } from "./broker.ts";
import { BROKER_ROUTE } from "./broker.ts";

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
  readonly logger: {
    info(message: string, ...args: readonly unknown[]): void;
    warn(message: string, ...args: readonly unknown[]): void;
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
  if (!value.ok) throw new Error(`${value.error.code}: ${value.error.hint}`);
  ctx.sidebarRight.openTab("browser", { params: { url: value.url } });
  return value;
}

function reportOpenFailure(ctx: ClientContext, error: unknown): void {
  ctx.logger.warn("harness-anything: broker unavailable (%s)", error instanceof Error ? error.message : String(error));
}

function HarnessIcon(
  { size }: PropsRuntime<"sidebar.panellist"> & SidebarPanelIconOwnerProps,
  ctx: ClientContext,
): ReactNode {
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
      onClick: () =>
        openHarnessBrowser(ctx).catch((error) => {
          reportOpenFailure(ctx, error);
        }),
      "aria-hidden": true,
    },
    "HA",
  );
}

function Tutorial({ ctx, t }: { readonly ctx: ClientContext; readonly t: (key: string) => string }): ReactNode {
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
          void openHarnessBrowser(ctx).catch((error) => reportOpenFailure(ctx, error));
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

export const inject = ["slots", "locale", "sidebarRight"];

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, messages), "harness-anything: dictionaries");
  const t = ctx.locale.bind(LOCALE_NAMESPACE);
  ctx.slots.inject("main", () =>
    ctx.slots.register({ name: "main", key: PANEL_ID, locale: LOCALE_NAMESPACE }, (() => Tutorial({ ctx, t })) as (
      props: never,
    ) => ReactNode),
  );
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      { name: "sidebar.panellist", id: PANEL_ID, order: 25, label: () => t("panel"), locale: LOCALE_NAMESPACE },
      ((props: PropsRuntime<"sidebar.panellist">) => HarnessIcon(props, ctx)) as (props: never) => ReactNode,
    ),
  );
}
