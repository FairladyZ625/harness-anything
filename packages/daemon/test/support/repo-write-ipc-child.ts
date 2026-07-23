import {
  RepoWriteChildIpcTransport
} from "../../src/runtime/repo-write-child-process-transport.ts";
import { repoWriteProtocolType } from "../../src/runtime/repo-write-protocol.ts";
import { committedCommandReceipt } from "./repo-write-terminal-fixture.ts";

const mode = process.argv[2] ?? "roundtrip";

if (mode === "exit") {
  setImmediate(() => process.exit(23));
} else {
  const transport = new RepoWriteChildIpcTransport();
  transport.onDisconnect(() => {
    process.exitCode = mode === "reject-parent" ? 42 : 0;
    setImmediate(() => process.exit());
  });
  transport.onMessage((message) => {
    if (message.kind === "submit") {
      void transport.send({
        protocol: repoWriteProtocolType,
        repoId: message.repoId,
        generation: message.generation,
        kind: "prepared",
        requestId: message.requestId,
        opId: `op-${message.requestId}`
      });
      return;
    }
    if (message.kind === "status") {
      void transport.send({
        protocol: repoWriteProtocolType,
        repoId: message.repoId,
        generation: message.generation,
        kind: "telemetry",
        requestId: message.requestId,
        opId: message.opId,
        phase: "total",
        elapsedMs: 2.5
      }).then(() => transport.send({
        protocol: repoWriteProtocolType,
        repoId: message.repoId,
        generation: message.generation,
        kind: "status",
        requestId: message.requestId,
        opId: message.opId,
        state: "committed",
        outcome: "committed",
        receipt: committedCommandReceipt("transport recovery")
      }));
      return;
    }
    if (message.kind === "shutdown") {
      void transport.send({
        protocol: repoWriteProtocolType,
        repoId: message.repoId,
        generation: message.generation,
        kind: "drained",
        requestId: message.requestId
      }).then(() => process.disconnect?.());
    }
  });

  if (mode === "malformed-child") {
    process.send?.({ protocol: "wrong", kind: "ready" });
  } else {
    await transport.send({
      protocol: repoWriteProtocolType,
      repoId: "repo-transport",
      generation: 1,
      kind: "ready"
    });
  }
}
