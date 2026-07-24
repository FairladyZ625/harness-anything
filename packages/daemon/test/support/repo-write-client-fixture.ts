import assert from "node:assert/strict";
import {
  RepoWriteClient,
  RepoWriteSendDeliveryError,
  type RepoWriteClientTransport
} from "../../src/runtime/repo-write-client.ts";
import {
  repoWriteProtocolType,
  type RepoWriteChildMessage,
  type RepoWriteParentMessage
} from "../../src/runtime/repo-write-protocol.ts";

export class FakeRepoWriteTransport implements RepoWriteClientTransport {
  readonly sent: RepoWriteParentMessage[] = [];
  failSendKind: RepoWriteParentMessage["kind"] | undefined;
  rejectSendKind: RepoWriteParentMessage["kind"] | undefined;
  rejectDelivery: "definitely-not-sent" | "possibly-sent" = "possibly-sent";
  private messageListener: ((message: RepoWriteChildMessage) => void) | undefined;
  private disconnectListener: ((error: Error) => void) | undefined;

  send(message: RepoWriteParentMessage): void | Promise<void> {
    if (message.kind === this.failSendKind) throw new Error(`fixture ${message.kind} send failed`);
    if (message.kind === this.rejectSendKind) {
      return Promise.reject(new RepoWriteSendDeliveryError(
        this.rejectDelivery,
        `fixture ${message.kind} send rejected`
      ));
    }
    this.sent.push(message);
  }

  onMessage(listener: (message: RepoWriteChildMessage) => void): () => void {
    this.messageListener = listener;
    return () => {
      this.messageListener = undefined;
    };
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListener = listener;
    return () => {
      this.disconnectListener = undefined;
    };
  }

  emit(message: RepoWriteChildMessage): void {
    this.messageListener?.(message);
  }

  disconnect(error = new Error("fixture disconnect")): void {
    this.disconnectListener?.(error);
  }
}

export function fixtureClient(
  transport: RepoWriteClientTransport,
  maxPendingRequests?: number
): RepoWriteClient {
  return new RepoWriteClient({
    repoId: "repo-canonical",
    generation: 7,
    transport,
    onTelemetry: () => undefined,
    ...(maxPendingRequests === undefined ? {} : { limits: { maxPendingRequests } })
  });
}

export function readyClient(transport: FakeRepoWriteTransport): RepoWriteClient {
  const client = fixtureClient(transport);
  transport.emit(readyFrame());
  return client;
}

export function command(commandName: string) {
  return {
    commandName,
    actor: { personId: "person_zeyu" },
    context: {},
    payload: {}
  } as const;
}

export function readyFrame(): RepoWriteChildMessage {
  return {
    ...childFrame("ready"),
    artifactIdentity: `sha256:${"a".repeat(64)}`
  };
}

export function childFrame<K extends string>(kind: K) {
  return {
    protocol: repoWriteProtocolType,
    repoId: "repo-canonical",
    generation: 7,
    kind
  } as const;
}

export function parentFrame<K extends string>(kind: K) {
  return {
    protocol: repoWriteProtocolType,
    repoId: "repo-canonical",
    generation: 7,
    kind
  } as const;
}

export function requestId(message: RepoWriteParentMessage | undefined): string {
  assert.ok(message && "requestId" in message);
  return message.requestId;
}
