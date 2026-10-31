export const EDGE_JOIN_ENTRY_CHANNEL = "harness:edge:join";
/** Main → renderer: the OS handed the app a harness-edge:// join link (protocol activation). */
export const EDGE_JOIN_LINK_CHANNEL = "harness:edge:join-link";

/** Provider device login the daemon's first edge-join call returns while nobody is signed in. */
export interface EdgeJoinDeviceLogin {
  readonly pending: true;
  readonly verificationUri: string;
  readonly userCode: string;
  readonly interval: number;
  readonly expiresAt: number;
  readonly transport?: "ssh-reverse";
}

export interface EdgeJoinRepositoryOutcome {
  readonly repoId: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly error?: string;
}

/** The settled join receipt: one row per invited repository. Carries no credential. */
export interface EdgeJoinJoined {
  readonly ok: boolean;
  readonly joinId: string;
  readonly state: "synced" | "partial";
  readonly repoIds: readonly string[];
  readonly repositories: readonly EdgeJoinRepositoryOutcome[];
  readonly nodeId?: string;
  readonly personId?: string;
}

export interface EdgeJoinProgressRepository {
  readonly repoId: string;
  readonly phase: "workspace" | "register" | "sync" | "synced" | "failed";
}

/** Live per-repository phases of the join this daemon is currently running. */
export interface EdgeJoinProgress {
  readonly repositories: readonly EdgeJoinProgressRepository[];
}

export interface EdgeJoinRejection {
  readonly ok: false;
  readonly code: string;
  readonly rejectionExplanation?: string;
}

export type EdgeJoinEntryRequest =
  | { readonly kind: "join"; readonly link: string }
  | { readonly kind: "poll" }
  | { readonly kind: "progress" }
  | { readonly kind: "open-login" };

export type EdgeJoinEntryReply =
  | ({ readonly ok: true } & (EdgeJoinDeviceLogin | EdgeJoinJoined | EdgeJoinProgress))
  | EdgeJoinRejection;

export interface EdgeJoinEntryApi {
  readonly begin: (input: { readonly link: string }) => Promise<unknown>;
  readonly poll: () => Promise<unknown>;
  readonly progress: () => Promise<unknown>;
  /** Opens the login page of the device sign-in this daemon started; takes no renderer-supplied URL. */
  readonly openLogin: () => Promise<unknown>;
  /** Subscribes to OS protocol activations; the listener receives a validated harness-edge:// link. */
  readonly onJoinLink: (listener: (link: string) => void) => () => void;
}
