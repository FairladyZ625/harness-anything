// @slice-activation PLT-Daemon W3 transport adapters exported for daemon composition roots.
import { randomBytes, randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { AttachTokenSubject, DaemonAuthenticationContext } from "./auth-context.ts";
import { serveJsonRpcStream, type DaemonTransportConnection, type TransportAuthenticationResult } from "./json-rpc-stream.ts";
import type { JsonRpcProtocolServer } from "../protocol/json-rpc-server.ts";

export interface AttachTokenMetadata {
  readonly tokenId: string;
  readonly daemonInstanceId: string;
  readonly hostProfileId: string;
  readonly userId: string;
  readonly tunnelNonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consumedAt?: string;
  readonly revokedAt?: string;
}

export interface IssuedAttachToken {
  readonly metadata: AttachTokenMetadata;
  readonly secret: string;
}

export interface IssueAttachTokenInput {
  readonly subject: AttachTokenSubject;
  readonly ttlMillis: number;
  readonly tunnelNonce?: string;
}

export interface ConsumeAttachTokenInput {
  readonly tokenId: string;
  readonly secret: string;
  readonly tunnelNonce: string;
  readonly daemonInstanceId: string;
  readonly hostProfileId: string;
}

export interface AttachTokenStore {
  readonly issue: (input: IssueAttachTokenInput) => IssuedAttachToken;
  readonly consume: (input: ConsumeAttachTokenInput) => AttachTokenMetadata | AttachTokenFailure;
  readonly revoke: (tokenId: string) => void;
  readonly listMetadata: () => ReadonlyArray<AttachTokenMetadata>;
}

export interface AttachTokenFailure {
  readonly ok: false;
  readonly code:
    | "token_already_used"
    | "token_daemon_mismatch"
    | "token_expired"
    | "token_host_mismatch"
    | "token_nonce_mismatch"
    | "token_not_found"
    | "token_revoked"
    | "token_secret_mismatch";
  readonly message: string;
}

export interface AttachTokenFrame {
  readonly type: "harness-daemon.attach-token/v1";
  readonly tokenId: string;
  readonly secret: string;
  readonly tunnelNonce: string;
  readonly daemonInstanceId: string;
  readonly hostProfileId: string;
}

export interface SshTunnelTokenStreamOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly endpoint?: string;
  readonly tokenStore: AttachTokenStore;
  readonly createProtocolServer: (authContext: DaemonAuthenticationContext) => JsonRpcProtocolServer;
}

export function createInMemoryAttachTokenStore(options: {
  readonly now?: () => string;
  readonly createSecret?: () => string;
  readonly createId?: (prefix: string) => string;
} = {}): AttachTokenStore {
  const now = options.now ?? (() => new Date().toISOString());
  const createSecret = options.createSecret ?? (() => randomBytes(24).toString("base64url"));
  const createId = options.createId ?? ((prefix: string) => `${prefix}-${randomUUID()}`);
  const records = new Map<string, { readonly metadata: AttachTokenMetadata; readonly secret: string; readonly subject: AttachTokenSubject }>();

  function save(record: { readonly metadata: AttachTokenMetadata; readonly secret: string; readonly subject: AttachTokenSubject }): AttachTokenMetadata {
    records.set(record.metadata.tokenId, record);
    return record.metadata;
  }

  return {
    issue: (input) => {
      const issuedAt = now();
      const metadata: AttachTokenMetadata = {
        tokenId: createId("token"),
        daemonInstanceId: input.subject.daemonInstanceId,
        hostProfileId: input.subject.hostProfileId,
        userId: input.subject.userId,
        tunnelNonce: input.tunnelNonce ?? createId("nonce"),
        issuedAt,
        expiresAt: new Date(Date.parse(issuedAt) + input.ttlMillis).toISOString()
      };
      const secret = createSecret();
      save({ metadata, secret, subject: input.subject });
      return { metadata, secret };
    },
    consume: (input) => {
      const record = records.get(input.tokenId);
      if (!record) return failure("token_not_found", `Attach token not found: ${input.tokenId}`);
      if (record.metadata.hostProfileId !== input.hostProfileId) return failure("token_host_mismatch", "Attach token host profile mismatch.");
      if (record.metadata.daemonInstanceId !== input.daemonInstanceId) return failure("token_daemon_mismatch", "Attach token daemon instance mismatch.");
      if (record.metadata.tunnelNonce !== input.tunnelNonce) return failure("token_nonce_mismatch", "Attach token tunnel nonce mismatch.");
      if (record.secret !== input.secret) return failure("token_secret_mismatch", "Attach token secret mismatch.");
      if (record.metadata.consumedAt) return failure("token_already_used", "Attach token has already been used.");
      if (record.metadata.revokedAt) return failure("token_revoked", "Attach token has been revoked.");
      if (Date.parse(record.metadata.expiresAt) <= Date.parse(now())) return failure("token_expired", "Attach token has expired.");
      return save({ ...record, metadata: { ...record.metadata, consumedAt: now() } });
    },
    revoke: (tokenId) => {
      const record = records.get(tokenId);
      if (record) save({ ...record, metadata: { ...record.metadata, revokedAt: now() } });
    },
    listMetadata: () => [...records.values()]
      .map((record) => record.metadata)
      .sort((left, right) => left.tokenId.localeCompare(right.tokenId))
  };
}

export function serveSshTunnelTokenStream(options: SshTunnelTokenStreamOptions): DaemonTransportConnection {
  const authContext: DaemonAuthenticationContext = {
    transportKind: "ssh-tunnel",
    endpoint: options.endpoint
  };
  return serveJsonRpcStream({
    input: options.input,
    output: options.output,
    transportKind: "ssh-tunnel",
    authContext,
    createProtocolServer: options.createProtocolServer,
    authenticateFirstFrame: (frame, context) => authenticateAttachTokenFrame(frame, context, options.tokenStore)
  });
}

export function attachTokenBootstrapFrame(input: ConsumeAttachTokenInput): AttachTokenFrame {
  return {
    type: "harness-daemon.attach-token/v1",
    tokenId: input.tokenId,
    secret: input.secret,
    tunnelNonce: input.tunnelNonce,
    daemonInstanceId: input.daemonInstanceId,
    hostProfileId: input.hostProfileId
  };
}

function authenticateAttachTokenFrame(
  frame: unknown,
  authContext: DaemonAuthenticationContext,
  tokenStore: AttachTokenStore
): TransportAuthenticationResult {
  if (!isAttachTokenFrame(frame)) {
    return { ok: false, code: "attach_token_required", message: "SSH tunnel transport requires an attach token bootstrap frame." };
  }
  const consumed = tokenStore.consume(frame);
  if (isAttachTokenFailure(consumed)) return { ok: false, code: consumed.code, message: consumed.message };
  return {
    ok: true,
    authContext: {
      ...authContext,
      sshTunnelToken: {
        tokenId: consumed.tokenId,
        tunnelNonce: consumed.tunnelNonce,
        subject: {
          userId: consumed.userId,
          hostProfileId: consumed.hostProfileId,
          daemonInstanceId: consumed.daemonInstanceId
        }
      }
    }
  };
}

function isAttachTokenFrame(value: unknown): value is AttachTokenFrame {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { readonly type?: unknown }).type === "harness-daemon.attach-token/v1"
    && typeof (value as { readonly tokenId?: unknown }).tokenId === "string"
    && typeof (value as { readonly secret?: unknown }).secret === "string"
    && typeof (value as { readonly tunnelNonce?: unknown }).tunnelNonce === "string"
    && typeof (value as { readonly daemonInstanceId?: unknown }).daemonInstanceId === "string"
    && typeof (value as { readonly hostProfileId?: unknown }).hostProfileId === "string";
}

function isAttachTokenFailure(value: AttachTokenMetadata | AttachTokenFailure): value is AttachTokenFailure {
  return "ok" in value && value.ok === false;
}

function failure(code: AttachTokenFailure["code"], message: string): AttachTokenFailure {
  return { ok: false, code, message };
}
