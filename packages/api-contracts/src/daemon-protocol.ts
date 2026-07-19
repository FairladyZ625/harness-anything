export type DaemonClientState = "connecting" | "live" | "stale" | "unknown";

export interface DaemonCapabilities {
  readonly notifications: boolean;
}

export interface DaemonRepoDescriptor {
  readonly repoId: string;
  readonly canonicalRoot: string;
}

/** Host-side view decoded from the daemon's command-receipt/v2 hello result. */
export interface HelloResult {
  readonly protocolVersion: number;
  readonly daemonId: string;
  readonly capabilities: DaemonCapabilities;
  readonly methods: ReadonlyArray<string>;
  readonly repos: ReadonlyArray<DaemonRepoDescriptor>;
}

export interface RepoKey {
  readonly endpoint: string;
  readonly repoId: string;
}

export interface ProjectionChangeEvent {
  readonly schema: "projection-change/v1";
  readonly sourceHash: string;
  readonly entities: ReadonlyArray<{ readonly kind: string; readonly id: string }>;
}

export interface ProjectionChangeNotification {
  readonly repoId: string;
  readonly event: ProjectionChangeEvent;
}

export interface Subscription {
  readonly repoId: string;
  readonly dispose: () => Promise<void>;
}

export interface Disposable {
  readonly dispose: () => void;
}

export interface DaemonClientDiagnostic {
  readonly code: "invalid_notification" | "unknown_notification" | "unsubscribed_notification" | "subscription_failed";
  readonly message: string;
  readonly frame?: unknown;
}

export interface DaemonSuccessReceipt<Data extends Record<string, unknown>> {
  readonly ok: true;
  readonly schema: "command-receipt/v2";
  readonly command: string;
  readonly details: { readonly data: Data };
}

export interface DaemonFailureReceipt {
  readonly ok: false;
  readonly schema: "command-receipt/v2";
  readonly command: string;
  readonly error?: { readonly code: string; readonly hint: string };
  readonly summary: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type DaemonReceipt<Data extends Record<string, unknown>> = DaemonSuccessReceipt<Data> | DaemonFailureReceipt;

export interface DaemonMethodMap {
  readonly "protocol.hello": {
    readonly input: { readonly protocolVersion: number; readonly clientName: string; readonly clientVersion: string };
    readonly output: DaemonReceipt<{
      readonly protocolVersion: number;
      readonly daemon: string;
      readonly capabilities: ReadonlyArray<string>;
      readonly methods: ReadonlyArray<string>;
      readonly repos: ReadonlyArray<DaemonRepoDescriptor>;
    }>;
  };
  readonly "repo.notifications.subscribe": {
    readonly input: { readonly repo: { readonly repoId: string } };
    readonly output: DaemonReceipt<{ readonly subscription: "projection-change/v1" }>;
  };
  readonly "repo.notifications.unsubscribe": {
    readonly input: { readonly repo: { readonly repoId: string } };
    readonly output: DaemonReceipt<{ readonly subscription: "projection-change/v1" }>;
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
