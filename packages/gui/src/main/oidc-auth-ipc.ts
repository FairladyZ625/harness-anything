import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { IpcMainInvokeEvent } from "electron";
import {
  OIDC_BINDING_STATUS_CHANNEL,
  OIDC_BOOTSTRAP_ADMIN_CHANNEL,
  OIDC_BOOTSTRAP_STATUS_CHANNEL,
  OIDC_CONFIGURE_CHANNEL,
  OIDC_LOGIN_CHANNEL,
  OIDC_LOGIN_URL_CHANNEL,
  OIDC_CANCEL_LOGIN_CHANNEL,
  OIDC_LOGOUT_CHANNEL,
  OIDC_OPEN_CONSOLE_CHANNEL,
  OIDC_STATUS_CHANNEL,
  type BootstrapAdminInput,
  type RbacBindingInput,
} from "../api/oidc-auth-contract.ts";
import { assertTrustedIpcSender } from "./ipc-handlers.ts";
import type { IpcWebContentsTrustPolicy } from "./security-policy.ts";
import type { JsonObject } from "@harness-anything/daemon";

interface Registrar {
  readonly handle: (
    channel: string,
    listener: (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>,
  ) => void;
}

export function registerOidcAuthIpc(
  registrar: Registrar,
  trustPolicy: IpcWebContentsTrustPolicy,
  ports: {
    readonly daemonRequest: (params: JsonObject) => Promise<JsonObject>;
    readonly openExternal: (url: string) => Promise<void>;
  },
): void {
  const logins = new Map<number, AbortController>();
  const daemonRequest = async (params: JsonObject) => requireSuccessfulAuthReply(await ports.daemonRequest(params));
  registrar.handle(OIDC_STATUS_CHANNEL, async (event, input) => {
    assertTrustedIpcSender(event, trustPolicy);
    return daemonRequest({ operation: "session", ...authTarget(input) });
  });
  registrar.handle(OIDC_LOGOUT_CHANNEL, async (event, input) => {
    assertTrustedIpcSender(event, trustPolicy);
    return daemonRequest({ operation: "logout", ...authTarget(input) });
  });
  registrar.handle(OIDC_LOGIN_CHANNEL, async (event, input) => {
    assertTrustedIpcSender(event, trustPolicy);
    const target = authTarget(input);
    if (logins.has(event.sender.id)) throw new Error("A sign-in is already in progress.");
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error("Sign-in cancelled."));
    logins.set(event.sender.id, controller);
    event.sender.once("destroyed", cancel);
    try {
      return await embeddedBrowserLogin({
        daemonRequest: (params) => daemonRequest({ ...params, ...target }),
        openBrowser: (url) => event.sender.send(OIDC_LOGIN_URL_CHANNEL, url),
        signal: controller.signal,
      });
    } finally {
      event.sender.removeListener("destroyed", cancel);
      logins.delete(event.sender.id);
    }
  });
  registrar.handle(OIDC_CANCEL_LOGIN_CHANNEL, async (event) => {
    assertTrustedIpcSender(event, trustPolicy);
    logins.get(event.sender.id)?.abort(new Error("Sign-in cancelled."));
    return { ok: true };
  });
  registrar.handle(OIDC_BINDING_STATUS_CHANNEL, async (event, input) => {
    assertTrustedIpcSender(event, trustPolicy);
    const reply = await ports.daemonRequest({ operation: "health", ...authTarget(input) });
    return normalizeBindingStatusReply(reply);
  });
  registrar.handle(OIDC_BOOTSTRAP_STATUS_CHANNEL, async (event, input) => {
    assertTrustedIpcSender(event, trustPolicy);
    return daemonRequest({ operation: "bootstrap-status", ...authTarget(input) });
  });
  registrar.handle(OIDC_BOOTSTRAP_ADMIN_CHANNEL, async (event, rawInput) => {
    assertTrustedIpcSender(event, trustPolicy);
    const input = rawInput as BootstrapAdminInput;
    if (authTarget(rawInput).repoId)
      throw new Error("First-administrator bootstrap requires the center's original local socket.");
    return daemonRequest({
      operation: "bootstrap-admin",
      username: input.username,
      email: input.email,
      displayName: input.displayName,
      password: input.password,
      personId: input.personId,
    });
  });
  registrar.handle(OIDC_CONFIGURE_CHANNEL, async (event, rawInput) => {
    assertTrustedIpcSender(event, trustPolicy);
    const input = rawInput as RbacBindingInput;
    if (input?.mode === "managed")
      return daemonRequest({ operation: "bootstrap", mode: "managed", ...authTarget(rawInput) });
    if (input?.mode !== "external") throw new Error("Keycloak mode must be managed or external.");
    return daemonRequest({
      mode: input.mode,
      url: input.url,
      realm: input.realm,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      ...authTarget(rawInput),
    });
  });
  registrar.handle(OIDC_OPEN_CONSOLE_CHANNEL, async (event, input) => {
    assertTrustedIpcSender(event, trustPolicy);
    const binding = normalizeBindingStatusReply(
      await ports.daemonRequest({ operation: "health", ...authTarget(input) }),
    );
    if (typeof binding.url !== "string" || typeof binding.realm !== "string")
      throw new Error("Daemon did not return a Keycloak binding.");
    const url = typeof binding.browserUrl === "string" ? binding.browserUrl : binding.url;
    const consoleUrl = `${url.replace(/\/$/u, "")}/admin/${encodeURIComponent(binding.realm)}/console/`;
    await ports.openExternal(consoleUrl);
    return { ok: true };
  });
}

function authTarget(input: unknown): JsonObject {
  const repoId = input && typeof input === "object" ? (input as Record<string, unknown>).repoId : undefined;
  if (repoId === undefined) return {};
  if (typeof repoId !== "string" || !/^[a-z][a-z0-9-]{0,62}$/u.test(repoId))
    throw new Error("Select a valid repository login target.");
  return { repoId };
}

export function requireSuccessfulAuthReply(reply: JsonObject): JsonObject {
  if (reply.ok !== false) return reply;
  const code = typeof reply.code === "string" ? reply.code : "auth_request_failed",
    explanation =
      typeof reply.rejectionExplanation === "string"
        ? reply.rejectionExplanation
        : "The authentication request failed.";
  throw Object.assign(new Error(`${code}: ${explanation}`), {
    code,
    rejectionExplanation: explanation,
  });
}

export function normalizeBindingStatusReply(reply: JsonObject): JsonObject {
  // An HTTP health result describes a configured service even when it is not ready.
  if (typeof reply.ready === "boolean") return reply;
  return reply.ok === false && reply.code === "rbac_not_configured"
    ? { ok: true, configured: false }
    : requireSuccessfulAuthReply(reply);
}

export async function embeddedBrowserLogin(ports: {
  readonly daemonRequest: (params: JsonObject) => Promise<JsonObject>;
  readonly openBrowser: (url: string) => void;
  readonly signal: AbortSignal;
}): Promise<unknown> {
  type CallbackResult = { readonly code: string; readonly state: string } | Error;
  let settle!: (value: CallbackResult) => void;
  const callback = new Promise<CallbackResult>((resolve) => {
      settle = resolve;
    }),
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/oidc/callback") {
        response.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code"),
        state = url.searchParams.get("state");
      if (!code || !state) {
        response.writeHead(400, { "content-type": "text/plain" }).end("Harness sign-in callback is incomplete.");
        settle(Object.assign(new Error("OIDC callback omitted code or state."), { code: "oidc_callback_invalid" }));
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" }).end("Completing Harness sign-in…");
      settle({ code, state });
    });
  // The callback is listening before the browser can navigate back, so a fast provider cannot race initialization.
  await new Promise<void>((resolve, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolve);
  });
  const interrupted = Promise.withResolvers<never>();
  const cancelled = () => interrupted.reject(new Error("Sign-in cancelled."));
  ports.signal.addEventListener("abort", cancelled, { once: true });
  const timeout = setTimeout(() => interrupted.reject(new Error("OIDC callback timed out.")), 300_000);
  try {
    ports.signal.throwIfAborted();
    const address = server.address() as AddressInfo,
      redirectUri = `http://127.0.0.1:${address.port}/oidc/callback`,
      begun = requireSuccessfulAuthReply(
        await Promise.race([ports.daemonRequest({ operation: "login-begin", redirectUri }), interrupted.promise]),
      );
    if (typeof begun.authorizationUrl !== "string") throw new Error("Daemon did not return an OIDC authorization URL.");
    ports.signal.throwIfAborted();
    ports.openBrowser(begun.authorizationUrl);
    const result = await Promise.race([callback, interrupted.promise]);
    if (result instanceof Error) throw result;
    ports.signal.throwIfAborted();
    return requireSuccessfulAuthReply(
      await Promise.race([ports.daemonRequest({ operation: "login-complete", ...result }), interrupted.promise]),
    );
  } finally {
    clearTimeout(timeout);
    ports.signal.removeEventListener("abort", cancelled);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
