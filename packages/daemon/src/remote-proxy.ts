import type net from "node:net";
import { readDaemonRegistry, type DaemonRegistryConnection } from "../../kernel/src/index.ts";
import { connectSocket, JsonRpcLineClient } from "./client/local-json-rpc-client.ts";
import { streamDaemonFacetAt } from "./client/local-json-rpc-stream.ts";
import {
  daemonStreamFacets,
  type DaemonStreamMethod,
  type DaemonStreamPayloadMap,
} from "./protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
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
  ) => Promise<RemoteProxySubscription>;
  readonly probe: (endpoint: string) => Promise<JsonObject>;
  readonly close: () => void;
}

interface RemoteProxyRoute {
  readonly connection: DaemonRegistryConnection & { readonly endpoint: string };
}

const connectTimeoutMs = 2_000;
const helloTimeoutMs = 10_000;

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
      return connectorFor(remote).request(method, params);
    },
    stream: async (repoId, method, payload) => {
      const remote = resolveRoute(repoId);
      await connectorFor(remote).hello();
      const values: JsonObject[] = [],
        waiters: Array<(value: JsonObject | null) => void> = [];
      let initial: JsonObject | undefined,
        closed = false,
        upstreamDetach: (() => void) | undefined;
      const detach = () => {
        if (closed) return;
        upstreamDetach?.();
        closeQueue();
      };
      try {
        upstreamDetach = await streamDaemonFacetAt({
          socketPath: remote.connection.endpoint,
          repoId,
          method,
          payload,
          onValue: (value) => {
            if (!isJsonRecord(value)) return;
            if (initial === undefined) {
              initial = value;
              return;
            }
            if (method === "repo.agentRuntime.attach" && Array.isArray(value.events)) {
              for (const event of value.events) if (isJsonRecord(event)) enqueue(event);
              return;
            }
            enqueue(value);
          },
          onClosed: () => closeQueue(),
        });
      } catch (error) {
        throw classifyRemoteProxyError(error);
      }
      if (initial === undefined) {
        upstreamDetach();
        throw remoteProxyError("remote_proxy_unavailable", "Remote stream closed before its attach receipt.");
      }
      if (!closed) streamDetachers.add(detach);
      return {
        initial,
        next: () => {
          const value = values.shift();
          if (value) return Promise.resolve(value);
          if (closed) return Promise.resolve(null);
          return new Promise((resolve) => waiters.push(resolve));
        },
        detach,
      };
      function closeQueue(): void {
        if (closed) return;
        closed = true;
        streamDetachers.delete(detach);
        for (const waiter of waiters.splice(0)) waiter(null);
      }
      function enqueue(value: JsonObject): void {
        const waiter = waiters.shift();
        if (waiter) waiter(value);
        else values.push(value);
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
      assertExactProtocol(hello);
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

function assertExactProtocol(hello: JsonObject): void {
  const protocol = isJsonRecord(hello.protocolVersion) ? hello.protocolVersion : null;
  if (
    hello.ok !== true ||
    protocol?.major !== currentDaemonProtocolVersion.major ||
    protocol.minor !== currentDaemonProtocolVersion.minor
  )
    throw remoteProxyError(
      "remote_proxy_protocol_mismatch",
      "The remote daemon protocol version must exactly match the local daemon.",
    );
}

function classifyRemoteProxyError(error: unknown): Error {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "remote_proxy_protocol_mismatch"
  )
    return error as unknown as Error;
  const message = error instanceof Error ? error.message : String(error);
  return remoteProxyError("remote_proxy_unavailable", `Remote daemon is unavailable: ${message}`);
}

function remoteProxyError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function isJsonRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function remoteProxyEventMethod(method: DaemonStreamMethod): string {
  return daemonStreamFacets.find((facet) => facet.method === method)!.eventMethod;
}
