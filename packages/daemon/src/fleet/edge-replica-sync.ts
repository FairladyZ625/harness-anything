import path from "node:path";
import {
  openPeer,
  runFleetReplicaPullClient,
  type FleetPeer,
  type FleetPeerOptions,
  type FleetReplicaPullClientOptions,
} from "./edge.ts";
import { recordHeadConfirmation } from "./replica-read-model.ts";

export interface FleetReplicaSessionPoolOptions {
  readonly idleMs?: number;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  readonly cancel?: (timer: NodeJS.Timeout) => void;
}

/** Authenticated replica sessions are scoped to one node/repository pair. */
export class FleetReplicaSessionPool {
  private readonly sessions = new Map<string, { peer: FleetPeer; timer?: NodeJS.Timeout }>();
  private readonly idleMs: number;
  private readonly schedule: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  private readonly cancel: (timer: NodeJS.Timeout) => void;

  constructor(options: FleetReplicaSessionPoolOptions = {}) {
    this.idleMs = options.idleMs ?? 30_000;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? ((timer) => clearTimeout(timer));
  }

  private key(options: FleetPeerOptions): string {
    return `${options.nodeId}\0${options.repoId}\0${options.hostname ?? "127.0.0.1"}\0${options.port}`;
  }

  async acquire(options: FleetPeerOptions): Promise<FleetPeer> {
    const key = this.key(options),
      existing = this.sessions.get(key);
    if (existing) {
      if (existing.timer) this.cancel(existing.timer);
      existing.timer = undefined;
      return existing.peer;
    }
    const peer = await openPeer(options);
    this.sessions.set(key, { peer });
    return peer;
  }

  release(options: FleetPeerOptions, peer: FleetPeer): void {
    const key = this.key(options),
      entry = this.sessions.get(key);
    if (!entry || entry.peer !== peer || entry.timer) return;
    entry.timer = this.schedule(() => {
      if (this.sessions.get(key)?.peer === peer) {
        this.sessions.delete(key);
        peer.close();
      }
    }, this.idleMs);
  }

  /** Drop a session that failed mid-pull so the next attempt opens a fresh connection. */
  discard(options: FleetPeerOptions, peer: FleetPeer): void {
    const key = this.key(options),
      entry = this.sessions.get(key);
    if (entry?.peer === peer) {
      if (entry.timer) this.cancel(entry.timer);
      this.sessions.delete(key);
    }
    peer.close();
  }

  close(): void {
    for (const { peer, timer } of this.sessions.values()) {
      if (timer) this.cancel(timer);
      peer.close();
    }
    this.sessions.clear();
  }
}

export interface FleetReplicaSyncOptions extends FleetReplicaPullClientOptions {
  readonly signal?: AbortSignal;
  /** Backoff after consecutive failures; a success resets it. */
  readonly retryDelaysMs?: readonly number[];
  readonly schedule?: (callback: () => void, delayMs: number) => void;
  /** Called for every failed pull or watch; the loop reconnects after the backoff. */
  readonly onFailure?: (error: unknown) => void;
  /** Called whenever the edge confirms the center head: after each pull and on each unchanged-head progress hint. */
  readonly onConfirmed?: (revision: number) => void | Promise<void>;
}

/**
 * Keep an edge replica fresh without putting network work on the read path. Each cycle pulls to the center's
 * current cut, then parks a `fleet.replica.watch/v1` on the same session until the center answers with a head
 * hint for a newer cut. Waiting is on the center's event, not a timer; the timer only spaces out reconnects
 * after a failure (center restart, refused connection, remote fault). Resolves once `signal` aborts.
 */
export function runFleetReplicaSync(options: FleetReplicaSyncOptions): Promise<void> {
  const delays = options.retryDelaysMs ?? [5_000, 15_000, 60_000],
    schedule = options.schedule ?? ((callback, delayMs) => void setTimeout(callback, delayMs)),
    sessionPool = options.sessionPool ?? new FleetReplicaSessionPool(),
    owned = options.sessionPool === undefined;
  let failures = 0;
  const cycle = async (): Promise<void> => {
    const pulled = await runFleetReplicaPullClient({ ...options, sessionPool });
    const revision =
      pulled.replica.schema === "fleet.replica.current/v1" ? pulled.replica.cut.revision : pulled.replica.ackCut;
    failures = 0;
    await options.onConfirmed?.(revision);
    const viewDir = path.join(options.viewRoot, "repos", options.repoId, "views", pulled.replica.viewId);
    // The center answers a watch either with a newer cut or, on its progress interval, with the unchanged
    // head. An unchanged head is a live confirmation: record it so local reads stay fresh, and keep watching.
    for (;;) {
      const head = await watchReplica(options, sessionPool, revision);
      if (head.revision > revision) return;
      recordHeadConfirmation(viewDir, head.revision);
      await options.onConfirmed?.(head.revision);
    }
  };
  return new Promise<void>((resolve) => {
    const stop = () => {
      if (owned) sessionPool.close();
      resolve();
    };
    const attempt = (): void => {
      if (options.signal?.aborted) return stop();
      cycle().then(attempt, (error: unknown) => {
        if (options.signal?.aborted) return stop();
        failures += 1;
        options.onFailure?.(error);
        schedule(attempt, delays[Math.min(failures, delays.length) - 1] ?? 60_000);
      });
    };
    attempt();
  });
}

async function watchReplica(options: FleetReplicaSyncOptions, pool: FleetReplicaSessionPool, afterRevision: number) {
  const session = await pool.acquire(options),
    abandon = () => pool.discard(options, session);
  options.signal?.addEventListener("abort", abandon, { once: true });
  // An abort that landed between the pull and this watch never fires the listener.
  if (options.signal?.aborted) abandon();
  let answered = false;
  try {
    const messageId = session.messageId();
    session.send({ schema: "fleet.replica.watch/v1", messageId, repoId: options.repoId, afterRevision });
    const hint = await session.next(null);
    if (hint.schema !== "fleet.replica.head-hint/v1" || hint.inReplyTo !== messageId)
      throw new Error("replica head hint expected");
    answered = true;
    return hint.cut;
  } finally {
    options.signal?.removeEventListener("abort", abandon);
    if (answered) pool.release(options, session);
    else if (!options.signal?.aborted) pool.discard(options, session);
  }
}
