import type { Subscription } from "../../api-contracts/src/daemon-protocol.ts";
import { PersistentDaemonClient, type PersistentDaemonClientOptions } from "./persistent-daemon-client.ts";

export interface PooledRepoConnection {
  readonly client: PersistentDaemonClient;
  readonly subscription: Subscription;
  readonly dispose: () => Promise<void>;
}

interface PoolEntry {
  readonly client: PersistentDaemonClient;
  readonly repos: Map<string, { refs: number; subscription: Subscription }>;
}

export class ConnectionPool {
  readonly #entries = new Map<string, PoolEntry>();
  readonly #createClient: (endpoint: string) => PersistentDaemonClient;

  constructor(createClient: (endpoint: string) => PersistentDaemonClient) {
    this.#createClient = createClient;
  }

  async acquire(endpoint: string, repoId: string): Promise<PooledRepoConnection> {
    let entry = this.#entries.get(endpoint);
    if (!entry) {
      entry = { client: this.#createClient(endpoint), repos: new Map() };
      this.#entries.set(endpoint, entry);
    }
    let repo = entry.repos.get(repoId);
    if (repo) {
      repo.refs += 1;
    } else {
      try {
        repo = { refs: 1, subscription: await entry.client.subscribe(repoId) };
      } catch (error) {
        if (entry.repos.size === 0) {
          this.#entries.delete(endpoint);
          await entry.client.dispose();
        }
        throw error;
      }
      entry.repos.set(repoId, repo);
    }
    let disposed = false;
    return {
      client: entry.client,
      subscription: repo.subscription,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await this.#release(endpoint, repoId);
      }
    };
  }

  snapshot(): ReadonlyArray<{ endpoint: string; repos: ReadonlyArray<string> }> {
    return [...this.#entries].map(([endpoint, entry]) => ({ endpoint, repos: [...entry.repos.keys()].sort() }));
  }

  async dispose(): Promise<void> {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.allSettled(entries.map((entry) => entry.client.dispose()));
  }

  async #release(endpoint: string, repoId: string): Promise<void> {
    const entry = this.#entries.get(endpoint);
    const repo = entry?.repos.get(repoId);
    if (!entry || !repo) return;
    repo.refs -= 1;
    if (repo.refs > 0) return;
    entry.repos.delete(repoId);
    await repo.subscription.dispose();
    if (entry.repos.size === 0) {
      this.#entries.delete(endpoint);
      await entry.client.dispose();
    }
  }
}

export function persistentClientFactory(options: Omit<PersistentDaemonClientOptions, "endpoint">): (endpoint: string) => PersistentDaemonClient {
  return (endpoint) => new PersistentDaemonClient({ ...options, endpoint });
}
