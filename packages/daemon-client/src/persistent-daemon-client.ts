import type {
  DaemonClientDiagnostic,
  DaemonClientState,
  DaemonMethod,
  Disposable,
  HelloResult,
  Input,
  Output,
  ProjectionChangeNotification,
  Subscription
} from "@harness-anything/api-contracts/daemon-protocol";
import { JsonRpcWriter } from "./json-rpc-writer.ts";
import type { JsonRpcConnection, PersistentTransport } from "./transport.ts";

export interface PersistentDaemonClientOptions {
  readonly endpoint: string;
  readonly transport: PersistentTransport;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly requestTimeoutMs?: number;
  readonly helloTimeoutMs?: number;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  readonly jitter?: () => number;
  readonly now?: () => number;
  readonly onDiagnostic?: (diagnostic: DaemonClientDiagnostic) => void;
}

export class PersistentDaemonClient {
  readonly #options: Required<Pick<PersistentDaemonClientOptions,
    "clientName" | "clientVersion" | "requestTimeoutMs" | "helloTimeoutMs" | "reconnectBaseMs" | "reconnectMaxMs" | "jitter" | "now" | "onDiagnostic">>
    & PersistentDaemonClientOptions;
  readonly #listeners = new Set<(event: ProjectionChangeNotification) => void>();
  readonly #stateListeners = new Set<(state: DaemonClientState) => void>();
  readonly #subscriptions = new Map<string, { refs: number }>();
  #connection?: JsonRpcConnection;
  #writer?: JsonRpcWriter;
  #hello?: HelloResult;
  #state: DaemonClientState = "connecting";
  #lastLiveAt?: number;
  #disposed = false;
  #connectFlight?: Promise<HelloResult>;
  #reconnectTimer?: ReturnType<typeof setTimeout>;
  #reconnectAttempt = 0;

  constructor(options: PersistentDaemonClientOptions) {
    this.#options = {
      ...options,
      clientName: options.clientName ?? "harness-daemon-client",
      clientVersion: options.clientVersion ?? "0.1.0",
      requestTimeoutMs: options.requestTimeoutMs ?? 1_000,
      helloTimeoutMs: options.helloTimeoutMs ?? options.requestTimeoutMs ?? 1_000,
      reconnectBaseMs: options.reconnectBaseMs ?? 250,
      reconnectMaxMs: options.reconnectMaxMs ?? 10_000,
      jitter: options.jitter ?? Math.random,
      now: options.now ?? Date.now,
      onDiagnostic: options.onDiagnostic ?? ((diagnostic) => console.warn(`[daemon-client:${diagnostic.code}] ${diagnostic.message}`))
    };
  }

  connect(signal?: AbortSignal): Promise<HelloResult> {
    if (this.#disposed) return Promise.reject(new Error("daemon client is disposed"));
    if (this.#hello && this.#connection) return Promise.resolve(this.#hello);
    if (this.#connectFlight) return this.#connectFlight;
    this.#connectFlight = this.#open(signal).finally(() => {
      this.#connectFlight = undefined;
    });
    return this.#connectFlight;
  }

  async request<M extends DaemonMethod>(method: M, params: Input<M>, signal?: AbortSignal): Promise<Output<M>> {
    await this.connect(signal);
    const writer = this.#writer;
    if (!writer) throw new Error("daemon connection is unavailable");
    return writer.request(method, params, { signal, timeoutMs: this.#options.requestTimeoutMs }) as Promise<Output<M>>;
  }

  async subscribe(repoId: string): Promise<Subscription> {
    const existing = this.#subscriptions.get(repoId);
    if (existing) {
      existing.refs += 1;
      return this.#subscriptionHandle(repoId);
    }
    this.#subscriptions.set(repoId, { refs: 1 });
    try {
      await this.connect();
      await this.#sendSubscription("repo.notifications.subscribe", repoId);
      return this.#subscriptionHandle(repoId);
    } catch (error) {
      this.#subscriptions.delete(repoId);
      this.#diagnose({
        code: "subscription_failed",
        message: `Projection subscription failed for ${repoId}: ${error instanceof Error ? error.message : String(error)}`
      });
      throw error;
    }
  }

  onEvent(listener: (event: ProjectionChangeNotification) => void): Disposable {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  onState(listener: (state: DaemonClientState) => void): Disposable {
    this.#stateListeners.add(listener);
    return { dispose: () => this.#stateListeners.delete(listener) };
  }

  state(): DaemonClientState {
    return this.#state;
  }

  lastLiveAt(): number | undefined {
    return this.#lastLiveAt;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.#reconnectTimer);
    const repos = [...this.#subscriptions.keys()];
    if (this.#writer) {
      await Promise.allSettled(repos.map((repoId) => this.#sendSubscription("repo.notifications.unsubscribe", repoId)));
    }
    this.#subscriptions.clear();
    this.#writer?.disconnect(new Error("daemon client disposed"));
    const connection = this.#connection;
    this.#connection = undefined;
    this.#writer = undefined;
    this.#hello = undefined;
    if (connection) await connection.close();
  }

  async #open(signal?: AbortSignal): Promise<HelloResult> {
    if (this.#state !== "stale") this.#transition("connecting");
    const connection = await this.#options.transport.open(this.#options.endpoint, signal);
    if (this.#disposed) {
      await connection.close();
      throw new Error("daemon client is disposed");
    }
    const writer = new JsonRpcWriter(connection);
    this.#connection = connection;
    this.#writer = writer;
    connection.onFrame((frame) => this.#acceptFrame(frame));
    connection.onClose((error) => this.#handleClose(error));
    const rawHello = await writer.request("protocol.hello", {
      protocolVersion: 1,
      clientName: this.#options.clientName,
      clientVersion: this.#options.clientVersion
    }, { signal, timeoutMs: this.#options.helloTimeoutMs });
    const hello = normalizeHello(rawHello);
    this.#hello = hello;
    this.#reconnectAttempt = 0;
    this.#transition("live");
    return hello;
  }

  #acceptFrame(frame: unknown): void {
    try {
      if (this.#writer?.accept(frame) === "response") return;
      const parsed = projectionNotification(frame);
      if (parsed.kind === "unknown") {
        this.#diagnose({ code: "unknown_notification", message: `Unknown daemon notification method ${parsed.method}.`, frame });
        return;
      }
      if (parsed.kind === "invalid") {
        this.#diagnose({ code: "invalid_notification", message: "Invalid repo.projection.changed notification payload.", frame });
        return;
      }
      if (!this.#subscriptions.has(parsed.notification.repoId)) {
        this.#diagnose({
          code: "unsubscribed_notification",
          message: `Projection notification arrived for unsubscribed repo ${parsed.notification.repoId}.`,
          frame
        });
        return;
      }
      for (const listener of this.#listeners) listener(parsed.notification);
    } catch (error) {
      this.#handleClose(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #handleClose(error?: Error): void {
    if (!this.#connection) return;
    this.#connection = undefined;
    this.#hello = undefined;
    this.#writer?.disconnect(error);
    this.#writer = undefined;
    if (this.#disposed) return;
    this.#transition("stale");
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    clearTimeout(this.#reconnectTimer);
    const exponential = Math.min(
      this.#options.reconnectMaxMs,
      this.#options.reconnectBaseMs * (2 ** this.#reconnectAttempt++)
    );
    const delay = Math.max(0, Math.round(exponential * (0.5 + this.#options.jitter())));
    this.#reconnectTimer = setTimeout(() => {
      void this.connect().then(async () => {
        for (const repoId of this.#subscriptions.keys()) {
          await this.#sendSubscription("repo.notifications.subscribe", repoId);
        }
      }).catch((error: unknown) => {
        this.#diagnose({
          code: "subscription_failed",
          message: `Projection reconnect failed: ${error instanceof Error ? error.message : String(error)}`
        });
        this.#scheduleReconnect();
      });
    }, delay);
  }

  async #release(repoId: string): Promise<void> {
    const subscription = this.#subscriptions.get(repoId);
    if (!subscription) return;
    subscription.refs -= 1;
    if (subscription.refs > 0) return;
    this.#subscriptions.delete(repoId);
    if (this.#writer) await this.#sendSubscription("repo.notifications.unsubscribe", repoId);
  }

  #subscriptionHandle(repoId: string): Subscription {
    let disposed = false;
    return {
      repoId,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await this.#release(repoId);
      }
    };
  }

  async #sendSubscription(
    method: "repo.notifications.subscribe" | "repo.notifications.unsubscribe",
    repoId: string
  ): Promise<void> {
    const writer = this.#writer;
    if (!writer) throw new Error("daemon connection is unavailable");
    const result = await writer.request(method, { repo: { repoId } }, { timeoutMs: this.#options.requestTimeoutMs });
    requireSuccessfulReceipt(result, method);
  }

  #diagnose(diagnostic: DaemonClientDiagnostic): void {
    this.#options.onDiagnostic(diagnostic);
  }

  #transition(next: DaemonClientState): void {
    if (this.#state === next) return;
    this.#state = next;
    if (next === "live") this.#lastLiveAt = this.#options.now();
    for (const listener of this.#stateListeners) listener(next);
  }
}

function normalizeHello(value: unknown): HelloResult {
  const data = requireSuccessfulReceipt(value, "protocol.hello");
  const methods = stringArray(data.methods);
  const repos = Array.isArray(data.repos)
    ? data.repos.filter((repo): repo is { repoId: string; canonicalRoot: string } =>
      isProtocolRecord(repo) && typeof repo.repoId === "string" && typeof repo.canonicalRoot === "string")
    : [];
  if (typeof data.protocolVersion !== "number" || typeof data.daemon !== "string" || repos.length !== (data.repos as unknown[] | undefined)?.length) {
    throw new Error("invalid protocol.hello result data");
  }
  return {
    protocolVersion: data.protocolVersion,
    daemonId: data.daemon,
    capabilities: { notifications: methods.includes("repo.notifications.subscribe") },
    methods,
    repos
  };
}

function requireSuccessfulReceipt(value: unknown, method: string): Record<string, unknown> {
  if (!isProtocolRecord(value) || value.schema !== "command-receipt/v2" || value.command !== method || typeof value.ok !== "boolean") {
    throw new Error(`invalid ${method} command receipt`);
  }
  if (!value.ok) {
    const error = isProtocolRecord(value.error) ? value.error : {};
    const code = typeof error.code === "string" ? error.code : "daemon_request_failed";
    const hint = typeof error.hint === "string" ? error.hint : typeof value.summary === "string" ? value.summary : method;
    throw new Error(`${code}: ${hint}`);
  }
  const details = isProtocolRecord(value.details) ? value.details : {};
  if (!isProtocolRecord(details.data)) throw new Error(`invalid ${method} command receipt data`);
  return details.data;
}

function projectionNotification(frame: unknown):
  | { readonly kind: "valid"; readonly notification: ProjectionChangeNotification }
  | { readonly kind: "invalid" }
  | { readonly kind: "unknown"; readonly method: string } {
  if (!isProtocolRecord(frame) || typeof frame.method !== "string") return { kind: "unknown", method: "<missing>" };
  if (frame.method !== "repo.projection.changed") return { kind: "unknown", method: frame.method };
  if (!isProtocolRecord(frame.params) || !isProtocolRecord(frame.params.repo) || !isProtocolRecord(frame.params.event)) {
    return { kind: "invalid" };
  }
  const { repo, event } = frame.params;
  if (typeof repo.repoId !== "string" || event.schema !== "projection-change/v1" || typeof event.sourceHash !== "string"
    || !Array.isArray(event.entities) || !event.entities.every(isProjectionEntity)) {
    return { kind: "invalid" };
  }
  return {
    kind: "valid",
    notification: {
      repoId: repo.repoId,
      event: {
        schema: "projection-change/v1",
        sourceHash: event.sourceHash,
        entities: event.entities
      }
    }
  };
}

function isProjectionEntity(value: unknown): value is { readonly kind: string; readonly id: string } {
  return isProtocolRecord(value) && typeof value.kind === "string" && typeof value.id === "string";
}

function stringArray(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error("invalid string array");
  return value;
}

function isProtocolRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
