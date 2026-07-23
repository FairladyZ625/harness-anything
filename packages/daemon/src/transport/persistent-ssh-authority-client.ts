// @slice-activation TW-01 persistent forced-command replication connection for future brokers.
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type {
  AuthorityOperationEnvelope,
  AuthorityOperationRecord,
  AuthorityOperationReceipt,
  AuthorizedOperationAttemptV2,
  ReplicaChangeRecord
} from "@harness-anything/application";
import {
  authorityWireFrameType,
  isAuthorityServerFrame,
  type AuthorityBlobResult,
  type AuthorityChangesAfterResult,
  type AuthorityNegotiatedProtocol,
  type AuthorityRequestFrame,
  type AuthorityResponseFrame,
  type AuthoritySnapshotLease,
  type AuthoritySnapshotManifest,
  type AuthoritySnapshotReservation,
  type Sha256Digest
} from "../authority/protocol.ts";
import {
  createLengthPrefixedFrameReader,
  defaultAuthorityMaxFrameBytes,
  encodeLengthPrefixedFrame
} from "./length-frame-codec.ts";

export interface AuthoritySshTarget {
  readonly destination: string;
  readonly fixedCommand: string;
}

export interface SshAuthorityChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly on: (event: "exit" | "error", listener: (...args: unknown[]) => void) => unknown;
  readonly kill: (signal?: NodeJS.Signals) => boolean;
}

export interface SshAuthorityChildFactory {
  readonly spawn: (command: "ssh", args: ReadonlyArray<string>) => SshAuthorityChild;
}

export interface TransportFlowLimits {
  readonly maxFrameBytes: number;
  readonly maxPendingRequests: number;
}

export interface PersistentSshAuthorityClientOptions {
  readonly target: AuthoritySshTarget;
  readonly workspaceId: string;
  readonly channelNonceDigest: () => string;
  readonly protocol: AuthorityNegotiatedProtocol;
  readonly childFactory?: SshAuthorityChildFactory;
  readonly limits?: Partial<TransportFlowLimits>;
  readonly onNotification?: (change: ReplicaChangeRecord) => void;
  readonly onDiagnostic?: (text: string) => void;
}

export class AuthorityTransportDisconnectedError extends Error {
  readonly opId: string | undefined;

  constructor(message: string, opId?: string) {
    super(message);
    this.name = "AuthorityTransportDisconnectedError";
    this.opId = opId;
  }
}

export class AuthorityReadDownRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "AuthorityReadDownRequestError";
    this.code = code;
  }
}

export class PersistentSshAuthorityClient {
  private readonly options: PersistentSshAuthorityClientOptions;
  private readonly limits: TransportFlowLimits;
  private child: SshAuthorityChild | undefined;
  private generation = 0;
  private sequence = 0;
  private ready = false;
  private closing = false;
  private connectionTask: Promise<void> | undefined;
  private readonly notificationListeners = new Set<(change: ReplicaChangeRecord) => void>();
  private readonly disconnectListeners = new Set<(error: AuthorityTransportDisconnectedError) => void>();
  private pending = new Map<string, {
    readonly generation: number;
    readonly opId?: string;
    readonly resolve: (frame: AuthorityResponseFrame) => void;
    readonly reject: (error: Error) => void;
  }>();

  constructor(options: PersistentSshAuthorityClientOptions) {
    this.options = options;
    this.limits = {
      maxFrameBytes: options.limits?.maxFrameBytes ?? defaultAuthorityMaxFrameBytes,
      maxPendingRequests: options.limits?.maxPendingRequests ?? 1024
    };
  }

  get connectionGeneration(): number {
    return this.generation;
  }

  connect(): Promise<void> {
    if (this.child && this.ready) return Promise.resolve();
    if (this.connectionTask) return this.connectionTask;
    this.closing = false;
    return this.runConnectionTask(() => this.openConnection());
  }

  reconnect(): Promise<void> {
    if (this.connectionTask) return this.connectionTask;
    this.closing = false;
    return this.runConnectionTask(async () => {
      await this.closeChild(new AuthorityTransportDisconnectedError("authority SSH connection replaced"));
      await this.openConnection();
    });
  }

  private async openConnection(): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    const childFactory = this.options.childFactory ?? nodeSshAuthorityChildFactory;
    const child = childFactory.spawn("ssh", buildAuthoritySshArgs(this.options.target));
    this.child = child;
    this.ready = false;
    const reader = createLengthPrefixedFrameReader(this.limits.maxFrameBytes);

    child.stderr.on("data", (chunk: Buffer | string) => this.options.onDiagnostic?.(String(chunk)));
    child.stdout.on("data", (chunk: Buffer) => {
      const batch = reader.push(chunk);
      for (const frame of batch.frames) this.handleServerFrame(frame, generation);
      if (batch.error) this.disconnect(batch.error, generation);
    });
    child.stdout.on("end", () => {
      const batch = reader.flush();
      if (batch.error) this.disconnect(batch.error, generation);
    });
    child.on("error", (error) => this.disconnect(asError(error), generation));
    child.on("exit", () => this.disconnect(new AuthorityTransportDisconnectedError("authority SSH connection exited"), generation));

    try {
      const response = await this.request({
        type: authorityWireFrameType,
        kind: "hello",
        requestId: this.nextRequestId(),
        connectionGeneration: generation,
        workspaceId: this.options.workspaceId,
        channelNonceDigest: this.options.channelNonceDigest(),
        protocol: this.options.protocol
      });
      if (!response.ok) throw new Error(response.error?.message ?? "authority protocol negotiation failed");
      if (this.closing || this.generation !== generation || this.child !== child) {
        throw new AuthorityTransportDisconnectedError("authority SSH connection changed during negotiation");
      }
      this.ready = true;
    } catch (error) {
      if (this.generation === generation && this.child === child) {
        await this.closeChild(new AuthorityTransportDisconnectedError(asError(error).message));
      }
      throw error;
    }
  }

  async submit(envelope: AuthorityOperationEnvelope): Promise<AuthorityOperationReceipt> {
    this.assertReady();
    const response = await this.request({
      type: authorityWireFrameType,
      kind: "submit",
      requestId: this.nextRequestId(),
      connectionGeneration: this.generation,
      envelope
    }, envelope.opId);
    if (!response.ok || !response.result) throw new Error(response.error?.message ?? "authority submit failed without receipt");
    return response.result as AuthorityOperationReceipt;
  }

  async submitV2(attempt: AuthorizedOperationAttemptV2): Promise<AuthorityOperationReceipt> {
    this.assertReady();
    const response = await this.request({
      type: authorityWireFrameType,
      kind: "submit_v2",
      requestId: this.nextRequestId(),
      connectionGeneration: this.generation,
      presentationToken: Buffer.from(attempt.presentationToken).toString("base64url"),
      envelope: Buffer.from(attempt.envelope).toString("base64url")
    });
    if (!response.ok || !response.result) throw new Error(response.error?.message ?? "authority V2 submit failed without receipt");
    return response.result as AuthorityOperationReceipt;
  }

  async getOperation(opId: string): Promise<AuthorityOperationRecord | undefined> {
    this.assertReady();
    const response = await this.request({
      type: authorityWireFrameType,
      kind: "get_operation",
      requestId: this.nextRequestId(),
      connectionGeneration: this.generation,
      workspaceId: this.options.workspaceId,
      opId
    }, opId);
    if (!response.ok) throw new Error(response.error?.message ?? "GetOperation failed");
    return (response.result ?? undefined) as AuthorityOperationRecord | undefined;
  }

  async beginSnapshotAndSubscribe(): Promise<AuthoritySnapshotReservation> {
    this.assertReady();
    const response = await this.request({
      type: authorityWireFrameType,
      kind: "begin_snapshot_and_subscribe",
      requestId: this.nextRequestId(),
      connectionGeneration: this.generation,
      workspaceId: this.options.workspaceId
    });
    return this.readDownResult(response, "authority snapshot reservation") as AuthoritySnapshotReservation;
  }

  async getSnapshotManifest(
    streamToken: string,
    manifestDigest: Sha256Digest
  ): Promise<AuthoritySnapshotManifest> {
    this.assertReady();
    const response = await this.request({
      type: authorityWireFrameType,
      kind: "get_snapshot_manifest",
      requestId: this.nextRequestId(),
      connectionGeneration: this.generation,
      streamToken,
      manifestDigest
    });
    return this.readDownResult(response, "authority snapshot manifest") as AuthoritySnapshotManifest;
  }

  async getBlob(streamToken: string, digest: Sha256Digest): Promise<Uint8Array> {
    this.assertReady();
    const response = await this.request({
      type: authorityWireFrameType,
      kind: "get_blob",
      requestId: this.nextRequestId(),
      connectionGeneration: this.generation,
      streamToken,
      digest
    });
    const result = this.readDownResult(response, "authority blob") as AuthorityBlobResult;
    if (result.encoding !== "base64" || result.digest !== digest) {
      throw new Error(`authority blob response metadata mismatch for ${digest}`);
    }
    const bytes = Buffer.from(result.bytes, "base64");
    if (bytes.toString("base64") !== result.bytes) {
      throw new Error(`authority blob response is not canonical base64 for ${digest}`);
    }
    return bytes;
  }

  async changesAfter(streamToken: string, sinceRevision: number): Promise<AuthorityChangesAfterResult> {
    this.assertReady();
    const response = await this.request({
      type: authorityWireFrameType,
      kind: "changes_after",
      requestId: this.nextRequestId(),
      connectionGeneration: this.generation,
      workspaceId: this.options.workspaceId,
      streamToken,
      sinceRevision
    });
    return this.readDownResult(response, "authority changes") as AuthorityChangesAfterResult;
  }

  async renewLease(streamToken: string): Promise<AuthoritySnapshotLease> {
    this.assertReady();
    const response = await this.request({
      type: authorityWireFrameType,
      kind: "renew_lease",
      requestId: this.nextRequestId(),
      connectionGeneration: this.generation,
      workspaceId: this.options.workspaceId,
      streamToken
    });
    return this.readDownResult(response, "authority lease renewal") as AuthoritySnapshotLease;
  }

  async getCutChange(streamToken: string): Promise<ReplicaChangeRecord | null> {
    this.assertReady();
    const response = await this.request({
      type: authorityWireFrameType,
      kind: "get_cut_change",
      requestId: this.nextRequestId(),
      connectionGeneration: this.generation,
      streamToken
    });
    if (!response.ok) throw this.readDownError(response, "authority cut change read");
    return (response.result ?? null) as ReplicaChangeRecord | null;
  }

  onNotification(listener: (change: ReplicaChangeRecord) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onDisconnect(listener: (error: AuthorityTransportDisconnectedError) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.closing = true;
    const connectionTask = this.connectionTask;
    await this.closeChild(new AuthorityTransportDisconnectedError("authority SSH connection closed"));
    await connectionTask?.catch(() => undefined);
  }

  private request(frame: AuthorityRequestFrame, opId?: string): Promise<AuthorityResponseFrame> {
    const child = this.child;
    if (!child) return Promise.reject(new AuthorityTransportDisconnectedError("authority SSH connection is not open", opId));
    if (this.pending.size >= this.limits.maxPendingRequests) return Promise.reject(new Error("authority transport pending queue is full"));
    return new Promise((resolve, reject) => {
      this.pending.set(frame.requestId, { generation: this.generation, ...(opId ? { opId } : {}), resolve, reject });
      try {
        child.stdin.write(encodeLengthPrefixedFrame(frame, this.limits.maxFrameBytes));
      } catch (error) {
        this.pending.delete(frame.requestId);
        reject(asError(error));
      }
    });
  }

  private handleServerFrame(value: unknown, sourceGeneration: number): void {
    if (sourceGeneration !== this.generation || !isAuthorityServerFrame(value)) return;
    if (value.connectionGeneration !== this.generation) return;
    if (value.kind === "replica_change") {
      try {
        this.options.onNotification?.(value.change);
      } catch (error) {
        this.options.onDiagnostic?.(`authority notification listener failed: ${asError(error).message}`);
      }
      for (const listener of this.notificationListeners) {
        try {
          listener(value.change);
        } catch (error) {
          this.options.onDiagnostic?.(`authority notification listener failed: ${asError(error).message}`);
        }
      }
      return;
    }
    if (value.kind === "stream_closed") {
      this.disconnect(new AuthorityTransportDisconnectedError(`${value.code}: ${value.message}`), sourceGeneration);
      return;
    }
    const pending = this.pending.get(value.requestId);
    if (!pending || pending.generation !== this.generation) return;
    this.pending.delete(value.requestId);
    pending.resolve(value);
  }

  private disconnect(error: Error, sourceGeneration: number): void {
    if (sourceGeneration !== this.generation) return;
    this.ready = false;
    this.child = undefined;
    const disconnected = error instanceof AuthorityTransportDisconnectedError
      ? error
      : new AuthorityTransportDisconnectedError(error.message);
    for (const [requestId, pending] of this.pending) {
      if (pending.generation !== sourceGeneration) continue;
      this.pending.delete(requestId);
      pending.reject(error instanceof AuthorityTransportDisconnectedError
        ? new AuthorityTransportDisconnectedError(error.message, pending.opId)
        : new AuthorityTransportDisconnectedError(error.message, pending.opId));
    }
    if (!this.closing) this.options.onDiagnostic?.(`authority transport disconnected: ${error.message}`);
    if (!this.closing) {
      for (const listener of this.disconnectListeners) {
        try {
          listener(disconnected);
        } catch (listenerError) {
          this.options.onDiagnostic?.(`authority disconnect listener failed: ${asError(listenerError).message}`);
        }
      }
    }
  }

  private async closeChild(error: AuthorityTransportDisconnectedError): Promise<void> {
    const child = this.child;
    const generation = this.generation;
    this.ready = false;
    this.child = undefined;
    this.rejectPendingGeneration(generation, error);
    if (child) {
      child.stdin.end();
      child.kill("SIGTERM");
    }
    await Promise.resolve();
  }

  private rejectPendingGeneration(generation: number, error: AuthorityTransportDisconnectedError): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.generation !== generation) continue;
      this.pending.delete(requestId);
      pending.reject(new AuthorityTransportDisconnectedError(error.message, pending.opId));
    }
  }

  private runConnectionTask(operation: () => Promise<void>): Promise<void> {
    const task = operation();
    this.connectionTask = task;
    void task.then(
      () => {
        if (this.connectionTask === task) this.connectionTask = undefined;
      },
      () => {
        if (this.connectionTask === task) this.connectionTask = undefined;
      }
    );
    return task;
  }

  private nextRequestId(): string {
    this.sequence += 1;
    return `${this.generation}:${this.sequence}`;
  }

  private assertReady(): void {
    if (!this.child || !this.ready) throw new AuthorityTransportDisconnectedError("authority SSH connection is not ready");
  }

  private readDownResult(response: AuthorityResponseFrame, description: string): NonNullable<AuthorityResponseFrame["result"]> {
    if (!response.ok || response.result === undefined || response.result === null) {
      throw this.readDownError(response, `${description} failed without a result`);
    }
    return response.result;
  }

  private readDownError(response: AuthorityResponseFrame, fallback: string): Error {
    return response.error
      ? new AuthorityReadDownRequestError(response.error.code, response.error.message)
      : new Error(fallback);
  }
}

export function buildAuthoritySshArgs(target: AuthoritySshTarget): ReadonlyArray<string> {
  if (!target.destination.trim() || !target.fixedCommand.trim()) throw new Error("authority SSH destination and fixed command are required");
  return [
    "-T",
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    "-o", "ClearAllForwardings=yes",
    "-o", "ExitOnForwardFailure=yes",
    target.destination,
    target.fixedCommand
  ];
}

const nodeSshAuthorityChildFactory: SshAuthorityChildFactory = {
  spawn: (command, args) => spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"] }) as SshAuthorityChild
};

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
