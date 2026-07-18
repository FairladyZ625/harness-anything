import type * as vscode from "vscode";
import type { RepoKey } from "@harness-anything/api-contracts";
import { ConnectionPool, type PooledRepoConnection } from "../../../daemon-client/src/connection-pool.ts";

export interface ResolvedWorkspaceRepo {
  readonly endpoint: string;
  readonly repoId: string;
}

export interface UnknownWorkspaceRoot {
  readonly folder: vscode.WorkspaceFolder;
  readonly action: "Register workspace folder with Harness";
}

export interface WorkspaceRouterOptions {
  readonly pool: ConnectionPool;
  readonly resolveFolder: (folder: vscode.WorkspaceFolder) => Promise<ResolvedWorkspaceRepo | undefined>;
  readonly onUnknownRoot: (input: UnknownWorkspaceRoot) => void;
}

interface FolderRoute {
  readonly folder: vscode.WorkspaceFolder;
  readonly repo?: RepoKey;
  readonly connection?: PooledRepoConnection;
}

export class WorkspaceRouter {
  readonly #options: WorkspaceRouterOptions;
  readonly #routes = new Map<string, FolderRoute>();

  constructor(options: WorkspaceRouterOptions) {
    this.#options = options;
  }

  async reconcile(folders: readonly vscode.WorkspaceFolder[]): Promise<void> {
    const wanted = new Map(folders.map((folder) => [folder.uri.toString(), folder]));
    for (const [key, route] of this.#routes) {
      if (wanted.has(key)) continue;
      this.#routes.delete(key);
      await route.connection?.dispose();
    }
    for (const [key, folder] of wanted) {
      if (this.#routes.has(key)) continue;
      const resolved = await this.#options.resolveFolder(folder);
      if (!resolved) {
        this.#routes.set(key, { folder });
        this.#options.onUnknownRoot({ folder, action: "Register workspace folder with Harness" });
        continue;
      }
      const repo = Object.freeze({ endpoint: resolved.endpoint, repoId: resolved.repoId });
      const connection = await this.#options.pool.acquire(repo.endpoint, repo.repoId);
      this.#routes.set(key, { folder, repo, connection });
    }
  }

  route(uri: vscode.Uri): RepoKey | undefined {
    return this.#matchingRoute(uri)?.repo;
  }

  connection(uri: vscode.Uri): PooledRepoConnection | undefined {
    return this.#matchingRoute(uri)?.connection;
  }

  async dispose(): Promise<void> {
    for (const route of this.#routes.values()) await route.connection?.dispose();
    this.#routes.clear();
  }

  #matchingRoute(uri: vscode.Uri): FolderRoute | undefined {
    return [...this.#routes.values()]
      .filter((route) => contains(route.folder.uri, uri))
      .sort((left, right) => right.folder.uri.path.length - left.folder.uri.path.length)[0];
  }
}

function contains(root: vscode.Uri, candidate: vscode.Uri): boolean {
  if (root.scheme !== candidate.scheme || root.authority !== candidate.authority) return false;
  const base = root.path.endsWith("/") ? root.path : `${root.path}/`;
  return candidate.path === root.path || candidate.path.startsWith(base);
}
