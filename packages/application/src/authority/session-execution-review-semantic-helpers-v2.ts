import { sha256Text } from "@harness-anything/kernel";
import type { HostedDocumentSnapshotV2 } from "./fact-relation-semantic-compiler-v2.ts";
import type {
  ExecutionActionPayloadV2,
  ReviewActionPayloadV2,
  SessionActionPayloadV2
} from "./session-execution-review-command-v2.ts";

export function absentHostedDocumentSnapshotV2(path: string): HostedDocumentSnapshotV2 {
  const digest = sha256Text(`harness-absent-hosted-document/v1:${path}`);
  return {
    body: "",
    epoch: digest,
    revision: 0n,
    blobDigest: Buffer.from(digest, "hex")
  };
}

export function sessionAction(schema: SessionActionPayloadV2["schema"]): "export" | "sync" | "archive" {
  return schema.slice("session.".length, -"/v1".length) as "export" | "sync" | "archive";
}

export function executionAction(schema: ExecutionActionPayloadV2["schema"]): "claim" | "submit" | "close" {
  return schema.slice("execution.".length, -"/v1".length) as "claim" | "submit" | "close";
}

export function reviewAction(schema: ReviewActionPayloadV2["schema"]): "create" | "dismiss" | "record" {
  return schema.slice("review.".length, -"/v1".length) as "create" | "dismiss" | "record";
}
