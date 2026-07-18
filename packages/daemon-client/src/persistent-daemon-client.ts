import type {
  DaemonClientState,
  DaemonMethod,
  Disposable,
  HelloResult,
  Input,
  Output,
  RepoEvent,
  Subscription
} from "../../api-contracts/src/daemon-protocol.ts";
import { DaemonRpcError, JsonRpcWriter } from "./json-rpc-writer.ts";
import type { JsonRpcConnection, PersistentTransport } from "./transport.ts";

export interface PersistentDaemonClientOptions {
  readonly endpoint: string;
  readonly transport: PersistentTransport;
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly requestTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  readonly jitter?: () => number;
  readonly now?: () => number;
  readonly readFull: (repoId: string, signal?: AbortSignal) => Promise<{ readonly headSeq: number }>;
}

export class PersistentDaemonClient {
  readonly #options: Required<Pick<PersistentDaemonClientOptions,
    "clientName" | "clientVersion" | "requestTimeoutMs" | "pollIntervalMs" | "reconnectBaseMs" | "reconnectMaxMs" | "jitter" | "now">>
    & PersistentDaemonClientOptions;
  readonly #listeners = new Set<(event: RepoEvent) => void>();
  readonly #stateListeners = new Set<(state: DaemonClientState) => void>();
  readonly #subscriptions = new Map<string, { cursor?: number; refs: number }>();
  #connection?: JsonRpcConnection;
  #writer?: JsonRpcWriter;
  #hello?: HelloResult;
  #state: DaemonClientState = "connecting";
  #lastLiveAt?: number;
  #disposed = false;
  #connectFlight?: Promise<HelloResult>;
  #reconnectTimer?: ReturnType<typeof setTimeout>;
  #pollTimer?: ReturnType<typeof setTimeout>;
  #reconnectAttempt = 0;

  constructor(options: PersistentDaemonClientOptions) {
    this.#options = {
      ...options,
      clientName: options.clientName ?? "harness-daemon-client",
      clientVersion: options.clientVersion ?? "0.1.0",
      requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
      pollIntervalMs: options.pollIntervalMs ?? 10_000,
      reconnectBaseMs: options.reconnectBaseMs ?? 250,
      reconnectMaxMs: options.reconnectMaxMs ?? 10_000,
      jitter: options.jitter ?? Math.random,
      now: options.now ?? Date.now
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

  async subscribe(repoId: string, afterSeq?: number): Promise<Subscription> {
    const existing = this.#subscriptions.get(repoId);
    if (existing) {
      existing.refs += 1;
      return this.#subscriptionHandle(repoId);
    }
    this.#subscriptions.set(repoId, { cursor: afterSeq, refs: 1 });
    try {
      await this.connect();
      await this.#synchronize(repoId);
      return this.#subscriptionHandle(repoId);
    } catch (error) {
      this.#subscriptions.delete(repoId);
      throw error;
    }
  }

  onEvent(listener: (event: RepoEvent) => void): Disposable {
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
    clearTimeout(this.#pollTimer);
    const repos = [...this.#subscriptions.keys()];
    if (this.#hello?.capabilities.notifications && this.#writer) {
      await Promise.allSettled(repos.map((repoId) => this.#writer!.request(
        "repo.notifications.unsubscribe",
        { repoId },
        { timeoutMs: Math.min(this.#options.requestTimeoutMs, 1_000) }
      )));
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
      client: { name: this.#options.clientName, version: this.#options.clientVersion }
    }, { signal, timeoutMs: this.#options.requestTimeoutMs });
    const hello = normalizeHello(rawHello);
    this.#hello = hello;
    this.#reconnectAttempt = 0;
    if (this.#state !== "stale" || this.#subscriptions.size === 0 || !hello.capabilities.notifications) {
      this.#transition("live");
    }
    if (!hello.capabilities.notifications) this.#schedulePoll();
    return hello;
  }

  async #synchronize(repoId: string): Promise<void> {
    const subscription = this.#subscriptions.get(repoId);
    if (!subscription) return;
    if (subscription.cursor === undefined) {
      subscription.cursor = (await this.#options.readFull(repoId)).headSeq;
    }
    if (!this.#hello?.capabilities.notifications) return;
    try {
      const result = await this.request("repo.notifications.subscribe", {
        repoId,
        ...(subscription.cursor === undefined ? {} : { afterSeq: subscription.cursor })
      });
      subscription.cursor = result.headSeq;
      this.#transition("live");
    } catch (error) {
      if (!isRetentionGap(error)) throw error;
      await this.#recoverFromGap(repoId);
    }
  }

  async #recoverFromGap(repoId: string): Promise<void> {
    const subscription = this.#subscriptions.get(repoId);
    if (!subscription) return;
    this.#transition("unknown");
    subscription.cursor = undefined;
    const snapshot = await this.#options.readFull(repoId);
    subscription.cursor = snapshot.headSeq;
    if (this.#hello?.capabilities.notifications) {
      const result = await this.request("repo.notifications.subscribe", { repoId, afterSeq: snapshot.headSeq });
      subscription.cursor = result.headSeq;
    }
    this.#transition("live");
  }

  #acceptFrame(frame: unknown): void {
    try {
      if (this.#writer?.accept(frame) === "response") return;
      const event = repoEvent(frame);
      if (!event) return;
      const subscription = this.#subscriptions.get(event.repoId);
      if (!subscription) return;
      if (subscription.cursor !== undefined && event.seq !== subscription.cursor + 1) {
        void this.#recoverFromGap(event.repoId).catch(() => this.#handleClose());
        return;
      }
      subscription.cursor = event.seq;
      for (const listener of this.#listeners) listener(event);
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
        for (const repoId of this.#subscriptions.keys()) await this.#synchronize(repoId);
      }).catch(() => this.#scheduleReconnect());
    }, delay);
  }

  #schedulePoll(): void {
    clearTimeout(this.#pollTimer);
    if (this.#disposed || this.#hello?.capabilities.notifications) return;
    this.#pollTimer = setTimeout(() => {
      void Promise.all([...this.#subscriptions.keys()].map(async (repoId) => {
        const snapshot = await this.#options.readFull(repoId);
        const subscription = this.#subscriptions.get(repoId);
        if (subscription) subscription.cursor = snapshot.headSeq;
      })).finally(() => this.#schedulePoll());
    }, this.#options.pollIntervalMs);
  }

  async #release(repoId: string): Promise<void> {
    const subscription = this.#subscriptions.get(repoId);
    if (!subscription) return;
    subscription.refs -= 1;
    if (subscription.refs > 0) return;
    this.#subscriptions.delete(repoId);
    if (this.#hello?.capabilities.notifications && this.#writer) {
      await this.request("repo.notifications.unsubscribe", { repoId });
    }
  }

  #subscriptionHandle(repoId: string): Subscription {
    let disposed = false;
    return {
      repoId,
      ...(this.#subscriptions.get(repoId)?.cursor === undefined ? {} : { afterSeq: this.#subscriptions.get(repoId)?.cursor }),
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await this.#release(repoId);
      }
    };
  }

  #transition(next: DaemonClientState): void {
    if (this.#state === next) return;
    this.#state = next;
    if (next === "live") this.#lastLiveAt = this.#options.now();
    for (const listener of this.#stateListeners) listener(next);
  }
}

function normalizeHello(value: unknown): HelloResult {
  if (!isProtocolRecord(value)) throw new Error("invalid protocol.hello result");
  const capabilities = value.capabilities;
  const capabilitySet = new Set(Array.isArray(capabilities) ? capabilities.filter((item): item is string => typeof item === "string") : []);
  const capabilityRecord = isProtocolRecord(capabilities) ? capabilities : {};
  return {
    protocolVersion: typeof value.protocolVersion === "number" ? value.protocolVersion : 1,
    daemonId: typeof value.daemonId === "string" ? value.daemonId : "unknown",
    capabilities: {
      notifications: capabilityRecord.notifications === true || capabilitySet.has("repo-notifications/v1"),
      retentionGap: capabilityRecord.retentionGap === true || capabilitySet.has("retention-gap/v1")
    }
  };
}

function repoEvent(frame: unknown): RepoEvent | undefined {
  if (!isProtocolRecord(frame) || frame.method !== "repo.event" || !isProtocolRecord(frame.params)) return undefined;
  const { repoId, seq, kind } = frame.params;
  return typeof repoId === "string" && typeof seq === "number" && typeof kind === "string"
    ? { repoId, seq, kind }
    : undefined;
}

function isRetentionGap(error: unknown): boolean {
  return error instanceof DaemonRpcError
    && (error.message === "RETENTION_GAP" || (isProtocolRecord(error.data) && error.data.code === "RETENTION_GAP"));
}

function isProtocolRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
