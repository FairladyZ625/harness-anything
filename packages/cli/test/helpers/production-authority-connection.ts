import { hostname } from "node:os";
import {
  channelDigest32,
  connectionGeneration
} from "../../../daemon/src/index.ts";

export function productionAuthorityActor() {
  return {
    personId: "person_alice",
    displayName: "Alice",
    primaryEmail: "alice@example.test",
    providerId: "transport-derived/v1",
    resolvedCredential: {
      kind: "unix-socket-owner-boundary" as const,
      issuer: `host:${hostname()}`,
      subject: String(process.getuid?.() ?? 0)
    }
  };
}

export function productionAuthorityConnection(actor: ReturnType<typeof productionAuthorityActor>) {
  return {
    schema: "authority-connection-context/v1" as const,
    connectionId: "production-recovery-connection",
    connectionGeneration: connectionGeneration("production-recovery-generation"),
    actor,
    repoId: "canonical",
    channelBinding: { digest: channelDigest32(Buffer.alloc(32, 0x52)), source: "transport-observed" as const },
    peerCredential: {
      schema: "os-observed-peer-credential/v1" as const,
      platform: "darwin" as const,
      source: "getpeereid" as const,
      uid: process.getuid?.() ?? 0,
      gid: process.getgid?.() ?? 0
    }
  };
}
