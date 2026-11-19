import {
  consumeDaemonStream,
  parseDaemonStreamEnd,
  parseDaemonStreamEvent,
  parseDaemonStreamResult,
  streamInterrupted,
  type DaemonRpcMethodMap,
  type DaemonRpcResult,
  type DaemonStreamMethod,
} from "@harness-anything/daemon/protocol";
import type { GuiTransport } from "../renderer/gui-transport.ts";
import { reportCollaborationResponse } from "../api/collaboration-response.ts";

const browserTokenStorageKey = "harness.browser.access-token";
const streamEndPrefix = "event: end\ndata: ";

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
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return {
    async request<Method extends keyof DaemonRpcMethodMap>(
      method: Method,
      params: DaemonRpcMethodMap[Method]["params"],
    ) {
      const response = await fetch("/rpc", {
        method: "POST",
        headers,
        body: JSON.stringify({ method, params }),
      });
      if (!response.ok) {
        throw await readBrowserFailure(method, response);
      }
      const reply = await response.json();
      reportCollaborationResponse(reply);
      return reply as DaemonRpcResult<Method>;
    },
    subscribe: (method, params, onValue, onError) => {
      const controller = new AbortController();
      void consumeDaemonStream({
        method,
        repoId: params.repo.repoId,
        payload: params.payload,
        signal: controller.signal,
        onValue,
        read: (payload, receive, active) =>
          readBrowserStream(method, { repo: params.repo, payload }, headers, receive, active),
      }).catch(onError);
      return () => controller.abort();
    },
    capabilities: () => ({
      stream: { status: "available" },
      terminal: { status: "available" },
      nativeFiles: unavailable,
      writes: { status: "available" },
    }),
  };
}

async function readBrowserStream(
  method: DaemonStreamMethod,
  params: object,
  headers: Record<string, string>,
  receive: (value: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  const attempt = new AbortController(),
    active = AbortSignal.any([attempt.signal, signal]);
  try {
    const response = await fetch("/stream", {
      method: "POST",
      headers: { ...headers, Accept: "text/event-stream" },
      body: JSON.stringify({ method, params }),
      signal: active,
    }).catch((error: unknown) => {
      throw streamInterrupted(error instanceof Error ? error.message : String(error));
    });
    if (!response.ok) {
      const error = await readBrowserFailure(method, response);
      if (error.code) return parseDaemonStreamEnd({ code: error.code }, error.message);
      throw error;
    }
    if (!response.body || response.headers.get("content-type") !== "text/event-stream")
      throw new Error("Browser transport returned an invalid stream response.");
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let pending = "",
      initial = true;
    try {
      for (;;) {
        const chunk = await reader.read().catch((error: unknown) => {
          throw streamInterrupted(error instanceof Error ? error.message : String(error));
        });
        if (chunk.done) throw streamInterrupted("Browser stream closed before its end frame.");
        pending += decoder.decode(chunk.value, { stream: true });
        let boundary = pending.indexOf("\n\n");
        while (boundary >= 0) {
          const event = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          if (event.startsWith(streamEndPrefix))
            return parseDaemonStreamEnd(JSON.parse(event.slice(streamEndPrefix.length)));
          if (!event.startsWith("data: ")) throw new Error("Invalid browser stream frame.");
          const value: unknown = JSON.parse(event.slice(6));
          receive(initial ? parseDaemonStreamResult(method, value) : parseDaemonStreamEvent(method, value));
          initial = false;
          boundary = pending.indexOf("\n\n");
        }
        if (pending.length > 4 * 1024 * 1024) throw new Error("Browser stream frame exceeds 4 MiB.");
      }
    } finally {
      reader.releaseLock();
    }
  } finally {
    attempt.abort();
  }
}

async function readBrowserFailure(method: string, response: Response): Promise<Error & { readonly code?: string }> {
  const fallback = `Browser transport rejected ${method} (${response.status}).`;
  try {
    const detail: unknown = await response.json();
    reportCollaborationResponse(detail);
    return browserTransportError(detail, fallback);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return new Error(fallback);
  }
}

function browserTransportError(value: unknown, fallback: string): Error & { readonly code?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return new Error(fallback);
  const failure = value as { readonly error?: unknown };
  if (!failure.error || typeof failure.error !== "object" || Array.isArray(failure.error)) return new Error(fallback);
  const detail = failure.error as { readonly code?: unknown; readonly hint?: unknown };
  const error = new Error(typeof detail.hint === "string" ? detail.hint : fallback);
  return typeof detail.code === "string" ? Object.assign(error, { code: detail.code }) : error;
}
