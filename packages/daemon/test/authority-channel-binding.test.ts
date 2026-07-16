// harness-test-tier: integration
import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  createInMemoryReplicaChangeLog,
  type AuthoritySubmissionService,
  type ProtocolSchemaTupleV2
} from "../../application/src/index.ts";
import {
  authorityWireFrameType,
  createLengthPrefixedFrameReader,
  encodeLengthPrefixedFrame,
  serveAuthorityForcedCommand
} from "../src/index.ts";

const protocol: ProtocolSchemaTupleV2 = {
  wire: 2, event: 2, receipt: 2, digest: 2, policy: 2,
  commandRegistry: 1, entityRegistry: 1, mutationRegistry: 1,
  localState: 1, applyJournal: 1
};

test("V2 forced-command rejects a server channel digest that is not exactly 32 bytes", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = createLengthPrefixedFrameReader();
  const frames: unknown[] = [];
  output.on("data", (chunk: Buffer) => frames.push(...reader.push(chunk).frames));
  const submissionService: AuthoritySubmissionService = {
    submit: async () => { throw new Error("submit is outside this handshake test"); },
    getOperation: async () => undefined
  };
  serveAuthorityForcedCommand({
    input,
    output,
    workspaceId: "workspace-one",
    protocol,
    serverChannelNonceDigest: Buffer.alloc(31),
    submissionService,
    replicaChangeLog: createInMemoryReplicaChangeLog()
  });

  const ended = once(output, "end");
  input.end(encodeLengthPrefixedFrame({
    type: authorityWireFrameType,
    kind: "hello",
    requestId: "hello-one",
    workspaceId: "workspace-one",
    channelNonceDigest: Buffer.alloc(32, 99).toString("hex"),
    protocol,
    connectionGeneration: 1
  }));
  await ended;

  assert.equal((frames[0] as { error?: { code?: string } }).error?.code, "SERVER_CHANNEL_BINDING_REQUIRED");
  assert.equal((frames[1] as { kind?: string }).kind, "stream_closed");
});
