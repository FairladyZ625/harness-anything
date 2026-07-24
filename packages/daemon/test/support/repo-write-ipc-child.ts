import {
  RepoWriteChildIpcTransport
} from "../../src/runtime/repo-write-child-process-transport.ts";
import { repoWriteProtocolType } from "../../src/runtime/repo-write-protocol.ts";
import { committedCommandReceipt } from "./repo-write-terminal-fixture.ts";
import { appendFileSync } from "node:fs";

const mode = process.argv[2] ?? "roundtrip";
const tracePath = process.argv[3];

if (mode === "exit") {
  setImmediate(() => process.exit(23));
} else {
  const transport = new RepoWriteChildIpcTransport();
  transport.onDisconnect(() => {
    process.exitCode = mode === "reject-parent" ? 42 : 0;
    setImmediate(() => process.exit());
  });
  transport.onMessage((message) => {
    if (message.kind === "direct") {
      trace(`direct:${message.command.commandName}`);
      if (mode === "swallow-direct") return;
      void transport.send({
        protocol: repoWriteProtocolType,
        repoId: message.repoId,
        generation: message.generation,
        kind: "direct-result",
        requestId: message.requestId,
        receipt: committedCommandReceipt("transport direct")
      });
      return;
    }
    if (message.kind === "submit") {
      trace(`submit:${String(message.command.payload.label ?? "")}`);
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
      trace(`status:${message.opId}`);
      if (mode === "swallow-proceed") {
        void transport.send({
          protocol: repoWriteProtocolType,
          repoId: message.repoId,
          generation: message.generation,
          kind: "status",
          requestId: message.requestId,
          opId: message.opId,
          state: "not-found"
        });
        return;
      }
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
    if (message.kind === "proceed") {
      if (mode === "swallow-proceed") return;
      if (mode === "crash-after-proceed") {
        process.exit(24);
      }
      void transport.send({
        protocol: repoWriteProtocolType,
        repoId: message.repoId,
        generation: message.generation,
        kind: "terminal",
        requestId: message.requestId,
        opId: message.opId,
        outcome: "committed",
        receipt: committedCommandReceipt("transport submission")
      });
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

  if (mode === "never-ready") {
    // Stay connected so the parent must enforce its readiness deadline.
  } else if (mode === "malformed-child") {
    process.send?.({ protocol: "wrong", kind: "ready" });
  } else {
    await transport.send({
      protocol: repoWriteProtocolType,
      repoId: "repo-transport",
      generation: 1,
      kind: "ready",
      artifactIdentity: `sha256:${"a".repeat(64)}`
    });
  }
}

function trace(event: string): void {
  if (tracePath) appendFileSync(tracePath, `${event}\n`, "utf8");
}
