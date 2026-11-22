/** The hosted sandbox API uses JSON-RPC for commands. An HTTP/SSE adapter can implement
 * read by resuming from the last acknowledged sequence and delivering a bounded page. */
export interface CloudSandboxAttempt {
  readonly repoId: string;
  readonly dispatchId: string;
  readonly attempt: number;
  readonly runtimeSessionId: string;
}

export interface CloudSandboxLaunch {
  readonly instanceId: string;
  readonly kindId: string;
  readonly model: string;
  readonly prompt: string;
  readonly providerSessionId?: string;
  readonly permissionMode?: string;
  readonly mcpPolicy?: string;
  readonly taskId: string | null;
  readonly executionId: string | null;
  /** Scoped to the attempt, supplied only to its configured sandbox host. */
  readonly executionCredential?: string;
}

interface SandboxCommandContext {
  readonly attempt: CloudSandboxAttempt;
  /** Idempotent and bound to the attempt and operation. Never reuse for a different effect. */
  readonly idempotencyKey: string;
  readonly deadline: number;
}

export interface CloudSandboxSteer {
  readonly opId: string;
  readonly version: number;
  readonly prompt: string;
  readonly controlRequestId?: string;
  readonly requestOpId?: string;
}

/** A stopped receipt must certify the entire sandbox lease is irreversibly terminated or
 * tombstoned before launch. It is also returned when the same attempt is reconciled later. */
export interface CloudSandboxStopped {
  readonly stopProof: "proven_stopped";
  readonly attempt: CloudSandboxAttempt;
  readonly exitCode: number | null;
}

export type CloudSandboxFrame = {
  readonly sequence: number;
} & (
  | { readonly kind: "stdout"; readonly line: string }
  | { readonly kind: "stderr"; readonly chunk: string }
  | { readonly kind: "steer"; readonly opId: string; readonly result: "applied" | "rejected" }
);

export interface CloudSandboxPage {
  readonly frames: readonly CloudSandboxFrame[];
  readonly live: boolean;
  /** Set after the last frame has been delivered. An empty page alone does not indicate exit. */
  readonly stopped?: CloudSandboxStopped;
}

interface CloudSandboxMethods {
  readonly "sandbox.start": {
    readonly input: { readonly launch: CloudSandboxLaunch };
    readonly output: { readonly accepted: true };
  };
  readonly "sandbox.read": {
    readonly input: { readonly after: number; readonly limit: number };
    readonly output: CloudSandboxPage;
  };
  readonly "sandbox.cancel": {
    readonly input: Record<never, never>;
    readonly output: CloudSandboxStopped | { readonly stopProof: "stop_unconfirmed" };
  };
  readonly "sandbox.steer": {
    readonly input: { readonly steer: CloudSandboxSteer };
    readonly output: { readonly accepted: true };
  };
}

export type CloudSandboxResponse<M extends keyof CloudSandboxMethods> = CloudSandboxMethods[M]["output"];

export interface CloudSandboxTransport {
  request<M extends keyof CloudSandboxMethods>(
    method: M,
    params: CloudSandboxMethods[M]["input"] & SandboxCommandContext,
    signal: AbortSignal,
  ): Promise<CloudSandboxMethods[M]["output"]>;
}

/** Transport errors opt in to retry. Application refusals keep their original error. */
export function isRetryableSandboxFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (("retryable" in error && error.retryable === true) ||
      ("data" in error &&
        typeof error.data === "object" &&
        error.data !== null &&
        "retryable" in error.data &&
        error.data.retryable === true))
  );
}

export function sandboxStopMatches(attempt: CloudSandboxAttempt, stopped: CloudSandboxStopped): boolean {
  return (
    stopped.stopProof === "proven_stopped" &&
    stopped.attempt?.repoId === attempt.repoId &&
    stopped.attempt.dispatchId === attempt.dispatchId &&
    stopped.attempt.attempt === attempt.attempt &&
    stopped.attempt.runtimeSessionId === attempt.runtimeSessionId &&
    (stopped.exitCode === null || Number.isSafeInteger(stopped.exitCode))
  );
}

export interface CloudRuntimeRegistration {
  /** Stable host ids must keep routing to the same durable lease namespace across daemon restarts. */
  readonly instanceTargets: Readonly<Record<string, { readonly hostId: string; readonly version: string }>>;
  readonly request: <M extends keyof CloudSandboxMethods>(
    hostId: string,
    method: M,
    params: CloudSandboxMethods[M]["input"] & SandboxCommandContext,
    signal: AbortSignal,
  ) => Promise<CloudSandboxMethods[M]["output"]>;
}

/** Bound the caller even when a transport never resolves after cancellation. */
export function waitForSandboxReply<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}
