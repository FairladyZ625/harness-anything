import {
  openRemoteDaemonStream,
  requestRemoteDaemonJsonRpc,
  type RemoteDaemonSshOptions,
} from "../../../daemon/src/client/remote-json-rpc-client.ts";
import {
  daemonProtocolError,
  isDaemonGuiActionMethod,
  isDaemonGuiReadMethod,
  type DaemonStreamPayloadMap,
} from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import {
  parseDaemonGuiActionResponse,
  parseDaemonGuiReadResponse,
  parseDaemonGuiReadResult,
} from "../../../daemon/src/protocol/gui-result-validation.ts";
import { streamDaemonFacetAt } from "./agent-runtime-stream-client.ts";
import { createGuiServiceBridgeForDaemon, type GuiServiceBridge, type ShippedGuiRoute } from "../api/service-bridge.ts";

export interface RemoteGuiProfile extends RemoteDaemonSshOptions {
  readonly daemonId: string;
}

export function createRemoteGuiServiceBridge(profile: RemoteGuiProfile): GuiServiceBridge {
  return createGuiServiceBridgeForDaemon(
    async (route, payload) => {
      const scoped = route.requiresRepo ? repoPayload(payload) : null,
        daemonPayload = scoped?.payload ?? ((payload ?? {}) as JsonObject),
        body: JsonObject = route.inputSchemaId === "gui.empty/v1" ? {} : { payload: daemonPayload },
        params: JsonObject = route.requiresRepo ? { repo: { repoId: scoped!.repoId }, ...body } : body;
      try {
        const result = await requestRemoteDaemonJsonRpc(
          profile,
          route.rpcMethod,
          params,
          requestTimeoutMs(route, daemonPayload),
        );
        const parsed = parseResult(route, result);
        return route.guiBridgeMethod === "getSystemStatus"
          ? {
              ...parsed,
              connection: {
                kind: "ssh",
                endpoint:
                  profile.host && profile.port
                    ? `${profile.host}:${profile.port}`
                    : (profile.sshConfigHost ?? "OpenSSH config"),
                ...(profile.user ? { user: profile.user } : {}),
                ...(profile.hostKeyAlias ? { hostKeyAlias: profile.hostKeyAlias } : {}),
              },
            }
          : parsed;
      } catch (error) {
        return daemonProtocolError(
          route.rpcMethod,
          remoteErrorCode(error),
          `Remote daemon request failed through the configured local endpoint. ${errorMessage(error)}`,
        ) as unknown as JsonObject;
      }
    },
    async (route, payload, emit) => {
      const scoped = repoPayload(payload);
      return streamDaemonFacetAt({
        socketPath: "remote-ssh",
        openSocket: () => openRemoteDaemonStream(profile),
        repoId: scoped.repoId,
        method: route.rpcMethod as keyof DaemonStreamPayloadMap,
        payload: scoped.payload as DaemonStreamPayloadMap[keyof DaemonStreamPayloadMap],
        onValue: emit,
        onClosed: (failure) =>
          emit({
            ok: false,
            code: failure.code,
            hint: `Remote daemon stream lost after ${failure.attempts} reconnect attempts (${failure.lastError}).`,
          }),
      });
    },
  );
}

export function resolveRemoteGuiProfile(env: NodeJS.ProcessEnv = process.env): RemoteGuiProfile | null {
  if (env.HARNESS_GUI_TRANSPORT !== "ssh") return null;
  const host = env.HARNESS_GUI_REMOTE_HOST?.trim(),
    port = Number(env.HARNESS_GUI_REMOTE_PORT ?? "0"),
    sshConfigHost = env.HARNESS_GUI_REMOTE_SSH_CONFIG_HOST?.trim(),
    daemonId = env.HARNESS_GUI_REMOTE_DAEMON_ID ?? "default";
  const hasDirectEndpoint = Boolean(host) && Number.isInteger(port) && port >= 1 && port <= 65_535;
  if (!hasDirectEndpoint && !sshConfigHost)
    throw new Error(
      "SSH transport requires HARNESS_GUI_REMOTE_HOST and a valid HARNESS_GUI_REMOTE_PORT, or HARNESS_GUI_REMOTE_SSH_CONFIG_HOST.",
    );
  const remoteCommand = env.HARNESS_GUI_REMOTE_COMMAND_JSON
    ? parseRemoteCommand(env.HARNESS_GUI_REMOTE_COMMAND_JSON)
    : ["ha", "daemon", "connect", "--stdio", "--daemon-id", daemonId];
  return {
    ...(host ? { host } : {}),
    ...(hasDirectEndpoint ? { port } : {}),
    daemonId,
    ...(env.HARNESS_GUI_REMOTE_USER ? { user: env.HARNESS_GUI_REMOTE_USER } : {}),
    ...(env.HARNESS_GUI_REMOTE_IDENTITY_FILE ? { identityFile: env.HARNESS_GUI_REMOTE_IDENTITY_FILE } : {}),
    ...(env.HARNESS_GUI_REMOTE_HOST_KEY_ALIAS ? { hostKeyAlias: env.HARNESS_GUI_REMOTE_HOST_KEY_ALIAS } : {}),
    ...(sshConfigHost ? { sshConfigHost } : {}),
    ...(env.HARNESS_GUI_SSH_COMMAND ? { sshCommand: env.HARNESS_GUI_SSH_COMMAND } : {}),
    remoteCommand,
  };
}

type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue = string | number | boolean | null | JsonObject | ReadonlyArray<JsonValue>;

function repoPayload(value: unknown): { readonly repoId: string; readonly payload: JsonObject } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Remote request requires repoId.");
  const { repoId, ...payload } = value as Record<string, JsonValue>;
  if (typeof repoId !== "string" || !/^[a-z][a-z0-9-]{0,62}$/u.test(repoId))
    throw new Error("Remote request has an invalid repoId.");
  return { repoId, payload };
}

function parseResult(route: ShippedGuiRoute, result: JsonObject): JsonObject {
  return (isDaemonGuiActionMethod(route.rpcMethod)
    ? parseDaemonGuiActionResponse(route.rpcMethod, result)
    : route.rpcMethod === "daemon.gui.control.receipt"
      ? parseDaemonGuiReadResult(route.rpcMethod, result)
      : isDaemonGuiReadMethod(route.rpcMethod)
        ? parseDaemonGuiReadResponse(route.rpcMethod, result)
        : result) as unknown as JsonObject;
}

function requestTimeoutMs(route: ShippedGuiRoute, payload: JsonObject): number {
  if (["saveAgent", "saveSquad", "updateSettings"].includes(route.guiBridgeMethod)) return 20_000;
  if (
    route.guiBridgeMethod === "createRuntimeInstance" ||
    route.guiBridgeMethod === "listRuntimeInstances" ||
    (route.guiBridgeMethod === "showRuntimeInstance" && payload.probe === true)
  )
    return 20_000;
  if (["showRuntimeInstance", "updateRuntimeInstance", "deleteRuntimeInstance"].includes(route.guiBridgeMethod))
    return 2_000;
  if (["signInRuntimeInstance", "signOutRuntimeInstance"].includes(route.guiBridgeMethod)) return 1_000;
  return 2_000;
}

function parseRemoteCommand(value: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("HARNESS_GUI_REMOTE_COMMAND_JSON must be a JSON array of strings.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((part) => typeof part !== "string" || part.length === 0)
  )
    throw new Error("HARNESS_GUI_REMOTE_COMMAND_JSON must be a non-empty JSON array of strings.");
  return parsed;
}

function remoteErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "remote_daemon_unavailable";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
