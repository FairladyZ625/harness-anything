import type net from "node:net";
import { TransformStream } from "node:stream/web";
import { daemonProtocolFleetPolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { assertRuntimeCredentialEndpoint } from "./client/local-daemon-target.ts";
import { consumeKnownError, readDaemonRegistry, type DaemonRegistryConnection } from "@harness-anything/kernel";
import { connectSocket, JsonRpcLineClient, daemonHelloFailureCode } from "./client/local-json-rpc-client.ts";
import { readDaemonStreamAt } from "./client/local-json-rpc-stream.ts";
import { isJsonObject, type JsonObject } from "./protocol/json-rpc-types.ts";
import { streamInterrupted } from "./protocol/stream-client.ts";
import { type DaemonStreamMethod, type DaemonStreamPayloadMap } from "./protocol/daemon-protocol.contract.ts";
import { currentDaemonProtocolVersion } from "./protocol/version.ts";

export interface RemoteProxySubscription {
  readonly initial: JsonObject;
  readonly next: () => Promise<JsonObject | null>;
  readonly detach: () => void;
}

export interface RemoteProxyManager {
  readonly route: (repoId: string) => boolean;
  readonly request: (repoId: string, method: string, params: JsonObject) => Promise<JsonObject>;
  readonly stream: (
    repoId: string,
    method: DaemonStreamMethod,
    payload: DaemonStreamPayloadMap[DaemonStreamMethod],
    signal?: AbortSignal,
  ) => Promise<RemoteProxySubscription>;
  readonly probe: (endpoint: string) => Promise<JsonObject>;
  readonly close: () => void;
}

interface RemoteProxyRoute {
  readonly connection: DaemonRegistryConnection & { readonly endpoint: string };
}

const { connectTimeoutMs, helloTimeoutMs } = daemonProtocolFleetPolicy.defaultValue.transport;

export function openRemoteProxyManager(userRoot: string): RemoteProxyManager {
  const connectors = new Map<string, RemoteEndpointConnector>(),
    streamDetachers = new Set<() => void>();
  const isRemoteProxy = (repoId: string): boolean =>
    readDaemonRegistry({ userRoot }).repos.some(
      (candidate) => candidate.repoId === repoId && candidate.state === "enabled" && candidate.mode === "remote-proxy",
    );
  const resolveRoute = (repoId: string): RemoteProxyRoute => {
    const registry = readDaemonRegistry({ userRoot }),
      repo = registry.repos.find(
        (candidate) =>
          candidate.repoId === repoId && candidate.state === "enabled" && candidate.mode === "remote-proxy",
      );
    if (!repo) throw remoteProxyError("repo_namespace_unknown", `Unknown remote-proxy namespace: ${repoId}.`);
    const connection = registry.connections.find((candidate) => candidate.id === repo.connectionId);
    if (
      !connection ||
      connection.kind !== "remote-endpoint" ||
      connection.state !== "enabled" ||
      connection.endpoint === undefined
    )
      throw remoteProxyError("remote_proxy_unavailable", `Remote connection ${repo.connectionId} is unavailable.`);
    return { connection: { ...connection, endpoint: connection.endpoint } };
  };
  const connectorFor = (remote: RemoteProxyRoute): RemoteEndpointConnector => {
    const current = connectors.get(remote.connection.id);
    if (current?.endpoint === remote.connection.endpoint) return current;
    current?.close();
    const connector = new RemoteEndpointConnector(remote.connection.endpoint);
    connectors.set(remote.connection.id, connector);
    return connector;
  };
  return {
    route: isRemoteProxy,
    request: async (repoId, method, params) => {
      const remote = resolveRoute(repoId);
      if (
        method.startsWith("daemon.runtimeInstance.") &&
        typeof params.payload === "object" &&
        params.payload !== null &&
        "apiKey" in params.payload
      )
        assertRuntimeCredentialEndpoint(remote.connection.endpoint);
      return connectorFor(remote).request(method, params);
    },
    stream: async (repoId, method, payload, callerSignal) => {
      const remote = resolveRoute(repoId),
        controller = new AbortController(),
        signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal,
        channel = new TransformStream<JsonObject>(),
        reader = channel.readable.getReader(),
        writer = channel.writable.getWriter(),
        first = Promise.withResolvers<JsonObject>();
      let opened = false;
      const detach = () => {
        controller.abort();
        streamDetachers.delete(detach);
        void reader.cancel().catch(consumeKnownError);
      };
      streamDetachers.add(detach);
      void readDaemonStreamAt({
        socketPath: remote.connection.endpoint,
        repoId,
        method,
        payload,
        signal,
        onValue: (value) => {
          if (!isJsonObject(value)) throw remoteProxyError("invalid_result", "Invalid remote stream frame.");
          if (opened) return writer.write(value);
          opened = true;
          first.resolve(value);
        },
      })
        .then(
          () => {
            if (!opened) first.reject(streamInterrupted("Remote stream closed before its attach receipt."));
            return writer.close();
          },
          (error: unknown) => {
            if (!opened) first.reject(classifyRemoteProxyError(error));
            return writer.abort(error);
          },
        )
        .catch(consumeKnownError);
      try {
        const initial = await first.promise;
        return {
          initial,
          next: async () => {
            const frame = await reader.read();
            return frame.done ? null : frame.value;
          },
          detach,
        };
      } catch (error) {
        detach();
        throw error;
      }
    },
    probe: async (endpoint) => {
      const connector = new RemoteEndpointConnector(endpoint);
      try {
        const hello = await connector.hello(),
          status = await connector.request("daemon.status", {});
        return {
          ok: true,
          endpoint,
          protocolVersion: hello.protocolVersion,
          build: hello.build,
          repos: Array.isArray(status.repos) ? status.repos : [],
        };
      } finally {
        connector.close();
      }
    },
    close: () => {
      for (const detach of [...streamDetachers]) detach();
      for (const connector of connectors.values()) connector.close();
      connectors.clear();
    },
  };
}

class RemoteEndpointConnector {
  readonly endpoint: string;
  private active: Promise<RemoteEndpointConnection> | null = null;
  private connected: RemoteEndpointConnection | null = null;
  constructor(endpoint: string) {
    this.endpoint = endpoint;
  }
  async hello(): Promise<JsonObject> {
    return (await this.connection()).hello;
  }
  async request(method: string, params: JsonObject): Promise<JsonObject> {
    try {
      return await (await this.connection()).client.request(method, params);
    } catch (error) {
      this.invalidate();
      throw classifyRemoteProxyError(error);
    }
  }
  close(): void {
    this.connected?.client.close();
    this.active = null;
    this.connected = null;
  }
  private connection(): Promise<RemoteEndpointConnection> {
    this.active ??= this.connect();
    return this.active;
  }
  private async connect(): Promise<RemoteEndpointConnection> {
    let socket: net.Socket | undefined;
    try {
      socket = await connectSocket(this.endpoint, connectTimeoutMs);
      const client = new JsonRpcLineClient(socket, socket),
        hello = await client.request(
          "protocol.hello",
          { protocolVersion: currentDaemonProtocolVersion },
          helloTimeoutMs,
        );
      const connection = { socket, client, hello };
      this.connected = connection;
      socket.once("close", () => {
        if (this.connected === connection) this.invalidate();
      });
      return connection;
    } catch (error) {
      socket?.destroy();
      this.active = null;
      throw classifyRemoteProxyError(error);
    }
  }
  private invalidate(): void {
    this.connected?.client.close();
    this.active = null;
    this.connected = null;
  }
}

interface RemoteEndpointConnection {
  readonly socket: net.Socket;
  readonly client: JsonRpcLineClient;
  readonly hello: JsonObject;
}

function classifyRemoteProxyError(error: unknown): Error {
  if (daemonHelloFailureCode(error) !== null) return error as Error;
  const message = error instanceof Error ? error.message : String(error);
  return remoteProxyError("remote_proxy_unavailable", `Remote daemon is unavailable: ${message}`);
}

function remoteProxyError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
