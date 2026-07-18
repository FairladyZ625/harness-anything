export type DaemonClientState = "connecting" | "live" | "stale" | "unknown";

export interface DaemonCapabilities {
  readonly notifications: boolean;
  readonly retentionGap: boolean;
}

export interface HelloResult {
  readonly protocolVersion: number;
  readonly daemonId: string;
  readonly capabilities: DaemonCapabilities;
}

export interface RepoKey {
  readonly endpoint: string;
  readonly repoId: string;
}

export interface RepoEvent {
  readonly repoId: string;
  readonly seq: number;
  readonly kind: string;
}

export interface Subscription {
  readonly repoId: string;
  readonly afterSeq?: number;
  readonly dispose: () => Promise<void>;
}

export interface Disposable {
  readonly dispose: () => void;
}

export interface DaemonMethodMap {
  readonly "protocol.hello": {
    readonly input: { readonly client: { readonly name: string; readonly version: string } };
    readonly output: HelloResult;
  };
  readonly "repo.notifications.subscribe": {
    readonly input: { readonly repoId: string; readonly afterSeq?: number };
    readonly output: { readonly subscribed: true; readonly headSeq: number };
  };
  readonly "repo.notifications.unsubscribe": {
    readonly input: { readonly repoId: string };
    readonly output: { readonly unsubscribed: true };
  };
  readonly "repo.read-full": {
    readonly input: { readonly repoId: string };
    readonly output: { readonly headSeq: number };
  };
}

export type DaemonMethod = keyof DaemonMethodMap;
export type Input<M extends DaemonMethod> = DaemonMethodMap[M]["input"];
export type Output<M extends DaemonMethod> = DaemonMethodMap[M]["output"];

// Serializable contracts intentionally exclude descriptor, token, credential,
// raw path, PID, and hash fields. Privileged attach material stays host-only.
export interface RendererSafeConnectionState {
  readonly repo: RepoKey;
  readonly state: DaemonClientState;
  readonly lastLiveAt?: number;
}
