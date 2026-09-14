import type { DaemonRpcMethodMap, DaemonRpcResult } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import type { GuiTransport } from "../renderer/gui-transport.ts";

const browserTokenStorageKey = "harness.browser.access-token";

export function loadBrowserGuiTransport(): GuiTransport {
  const hashToken = new URLSearchParams(window.location.hash.slice(1)).get("access_token");
  if (hashToken) window.sessionStorage.setItem(browserTokenStorageKey, hashToken);
  const token = hashToken ?? window.sessionStorage.getItem(browserTokenStorageKey);
  if (!token) throw new Error("GUI transport credentials are unavailable.");
  if (hashToken) history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  return createBrowserGuiTransport(token);
}

export function createBrowserGuiTransport(token: string): GuiTransport {
  const unavailable = { status: "unavailable", reason: "Available in the desktop app only." } as const;
  return {
    async request<Method extends keyof DaemonRpcMethodMap>(
      method: Method,
      params: DaemonRpcMethodMap[Method]["params"],
    ) {
      const response = await fetch("/rpc", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ method, params }),
      });
      if (!response.ok) {
        const fallback = `Browser transport rejected ${method} (${response.status}).`;
        let detail: unknown;
        try {
          detail = await response.json();
        } catch {
          throw new Error(fallback);
        }
        throw browserTransportError(detail, fallback);
      }
      return (await response.json()) as DaemonRpcResult<Method>;
    },
    capabilities: () => ({
      stream: unavailable,
      terminal: unavailable,
      nativeFiles: unavailable,
      writes: { status: "available" },
    }),
  };
}

function browserTransportError(value: unknown, fallback: string): Error & { readonly code?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return new Error(fallback);
  const failure = value as { readonly error?: unknown };
  if (!failure.error || typeof failure.error !== "object" || Array.isArray(failure.error)) return new Error(fallback);
  const detail = failure.error as { readonly code?: unknown; readonly hint?: unknown };
  const error = new Error(typeof detail.hint === "string" ? detail.hint : fallback);
  return typeof detail.code === "string" ? Object.assign(error, { code: detail.code }) : error;
}
