import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { IpcMainInvokeEvent } from "electron";
import {
  OIDC_BINDING_STATUS_CHANNEL,
  OIDC_BOOTSTRAP_ADMIN_CHANNEL,
  OIDC_BOOTSTRAP_STATUS_CHANNEL,
  OIDC_CONFIGURE_CHANNEL,
  OIDC_LOGIN_CHANNEL,
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
  registrar.handle(OIDC_STATUS_CHANNEL, async (event) => {
    assertTrustedIpcSender(event, trustPolicy);
    return ports.daemonRequest({ operation: "session" });
  });
  registrar.handle(OIDC_LOGOUT_CHANNEL, async (event) => {
    assertTrustedIpcSender(event, trustPolicy);
    return ports.daemonRequest({ operation: "logout" });
  });
  registrar.handle(OIDC_LOGIN_CHANNEL, async (event) => {
    assertTrustedIpcSender(event, trustPolicy);
    return systemBrowserLogin(ports);
  });
  registrar.handle(OIDC_BINDING_STATUS_CHANNEL, async (event) => {
    assertTrustedIpcSender(event, trustPolicy);
    return ports.daemonRequest({ operation: "health" });
  });
  registrar.handle(OIDC_BOOTSTRAP_STATUS_CHANNEL, async (event) => {
    assertTrustedIpcSender(event, trustPolicy);
    return ports.daemonRequest({ operation: "bootstrap-status" });
  });
  registrar.handle(OIDC_BOOTSTRAP_ADMIN_CHANNEL, async (event, rawInput) => {
    assertTrustedIpcSender(event, trustPolicy);
    const input = rawInput as BootstrapAdminInput;
    return ports.daemonRequest({
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
    if (input?.mode === "managed") return ports.daemonRequest({ operation: "bootstrap", mode: "managed" });
    if (input?.mode !== "external") throw new Error("Keycloak mode must be managed or external.");
    return ports.daemonRequest({ mode: input.mode, url: input.url, realm: input.realm, clientId: input.clientId });
  });
  registrar.handle(OIDC_OPEN_CONSOLE_CHANNEL, async (event) => {
    assertTrustedIpcSender(event, trustPolicy);
    const binding = await ports.daemonRequest({ operation: "health" });
    if (typeof binding.url !== "string" || typeof binding.realm !== "string")
      throw new Error("Daemon did not return a Keycloak binding.");
    const consoleUrl = `${binding.url.replace(/\/$/u, "")}/admin/${encodeURIComponent(binding.realm)}/console/`;
    await ports.openExternal(consoleUrl);
    return { ok: true };
  });
}

export async function systemBrowserLogin(ports: {
  readonly daemonRequest: (params: JsonObject) => Promise<JsonObject>;
  readonly openExternal: (url: string) => Promise<void>;
}): Promise<unknown> {
  let settle!: (value: { readonly code: string; readonly state: string }) => void, reject!: (error: Error) => void;
  const callback = new Promise<{ readonly code: string; readonly state: string }>((resolve, rejectPromise) => {
      settle = resolve;
      reject = rejectPromise;
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
        reject(Object.assign(new Error("OIDC callback omitted code or state."), { code: "oidc_callback_invalid" }));
        return;
      }
      response
        .writeHead(200, { "content-type": "text/plain" })
        .end("Harness sign-in complete. You can close this tab.");
      settle({ code, state });
    });
  // The callback is listening before the browser can navigate back, so a fast provider cannot race initialization.
  await new Promise<void>((resolve, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolve);
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const address = server.address() as AddressInfo,
      redirectUri = `http://127.0.0.1:${address.port}/oidc/callback`,
      begun = await ports.daemonRequest({ operation: "login-begin", redirectUri });
    if (typeof begun.authorizationUrl !== "string") throw new Error("Daemon did not return an OIDC authorization URL.");
    await ports.openExternal(begun.authorizationUrl);
    const result = await Promise.race([
      callback,
      new Promise<never>(
        (_resolve, rejectTimeout) =>
          (timeout = setTimeout(
            () => rejectTimeout(Object.assign(new Error("OIDC callback timed out."), { code: "oidc_timeout" })),
            300_000,
          )),
      ),
    ]);
    return await ports.daemonRequest({ operation: "login-complete", ...result });
  } finally {
    if (timeout) clearTimeout(timeout);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
