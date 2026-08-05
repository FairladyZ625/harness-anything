import {
  RepoWriteChildIpcTransport
} from "../../src/runtime/repo-write-child-process-transport.ts";
import { createRepoWriteChildHost } from "../../src/runtime/repo-write-child-host.ts";
import { repoWriteProtocolType } from "../../src/runtime/repo-write-protocol.ts";
import { committedCommandReceipt } from "./repo-write-terminal-fixture.ts";
import { appendFileSync } from "node:fs";

const mode = process.argv[2] ?? "roundtrip";
const tracePath = process.argv[3];

if (mode === "ignore-sigterm-shutdown-failure") {
  process.on("SIGTERM", () => undefined);
}

if (mode === "expected-direct-rejection") {
  const transport = new RepoWriteChildIpcTransport();
  transport.onDisconnect(() => setImmediate(() => process.exit()));
  const host = createRepoWriteChildHost({
    repoId: "repo-transport",
    workspaceId: "workspace-canonical",
    generation: 1,
    artifactIdentity: `sha256:${"a".repeat(64)}`,
    transport,
    hooks: {
      prepare: async () => {
        throw new Error("durable prepare is not used by this direct fixture");
      },
      direct: async () => {
        throw {
          _tag: "WriteRejected",
          code: "task_holder_required",
          reason: "TASK_LIFECYCLE_HOLDER_RELEASE_REQUIRED:task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8",
          context: { taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8" },
          retryable: false
        };
      },
      lookup: async () => ({ state: "not-found" }),
      shutdown: async () => undefined
    }
  });
  transport.onMessage((message) => {
    void host.receive(message);
  });
  await host.start();
} else if (mode === "exit") {
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
      if (mode === "swallow-direct") {
        void transport.send({
          protocol: repoWriteProtocolType,
          repoId: message.repoId,
          generation: message.generation,
          kind: "telemetry",
          requestId: message.requestId,
          phase: "projection",
          elapsedMs: 2.5
        });
        return;
      }
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
      trace(`submit:${submissionLabel(message.command.payload)}`);
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
      if (mode === "swallow-proceed") {
        void transport.send({
          protocol: repoWriteProtocolType,
          repoId: message.repoId,
          generation: message.generation,
          kind: "telemetry",
          requestId: message.requestId,
          opId: message.opId,
          phase: "git",
          elapsedMs: 2.5
        });
        return;
      }
      if (mode === "crash-after-proceed") {
        process.exit(24);
      }
      if (mode === "slow-terminal") {
        void transport.send({
          protocol: repoWriteProtocolType,
          repoId: message.repoId,
          generation: message.generation,
          kind: "telemetry",
          requestId: message.requestId,
          opId: message.opId,
          phase: "git",
          elapsedMs: 2.5
        });
        setTimeout(() => {
          void transport.send({
            protocol: repoWriteProtocolType,
            repoId: message.repoId,
            generation: message.generation,
            kind: "terminal",
            requestId: message.requestId,
            opId: message.opId,
            outcome: "committed",
            receipt: committedCommandReceipt("slow canonical publication")
          });
        }, 60);
        return;
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
      if (mode === "slow-shutdown-success") {
        setTimeout(() => {
          void transport.send({
            protocol: repoWriteProtocolType,
            repoId: message.repoId,
            generation: message.generation,
            kind: "drained",
            requestId: message.requestId
          });
        }, 2_250);
        return;
      }
      if (mode === "shutdown-failure" || mode === "ignore-sigterm-shutdown-failure") {
        void transport.send({
          protocol: repoWriteProtocolType,
          repoId: message.repoId,
          generation: message.generation,
          kind: "failure",
          requestId: message.requestId,
          phase: "before-proceed",
          outcome: "not-started",
          replay: "caller-may-retry",
          code: "SHUTDOWN_FAILED",
          diagnostic: "fixture graceful drain failed"
        });
        return;
      }
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
    if (mode === "recovery-deferred") {
      await transport.send({
        protocol: repoWriteProtocolType,
        repoId: "repo-transport",
        generation: 1,
        kind: "recovery-deferred",
        outerOpId: "repo-write:historical",
        code: "GIT_PATH_NOT_SAFE",
        diagnostic: "historical recovery remains fail-closed"
      });
    }
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

function submissionLabel(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const command = (payload as { readonly command?: unknown }).command;
  if (!command || typeof command !== "object" || Array.isArray(command)) return "";
  const action = (command as { readonly action?: unknown }).action;
  if (!action || typeof action !== "object" || Array.isArray(action)) return "";
  const title = (action as { readonly title?: unknown }).title;
  return typeof title === "string" ? title : "";
}
