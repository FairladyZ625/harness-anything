import { prepareStorageWorkerContext, daemonWriterSupportsCommitPhase } from "@harness-anything/storage";
import { MessageChannel, Worker } from "node:worker_threads";
import type { RepoWriterBootstrapV1 } from "./repo-writer-protocol.ts";

let host: Worker | undefined;
let connections = 0;

/** SQLite shares preparation; a SQL COMMIT that can wait indefinitely owns a separate host turn. */
export function connectRepoWriterHost(writer: Worker, bootstrap: RepoWriterBootstrapV1): void {
  const createHost = () =>
    new Worker(
      new URL(`./repo-orchestration-worker${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`, import.meta.url),
      {
        name: "repo-orchestration",
        execArgv: process.execArgv.filter(
          (arg) => arg === "--experimental-strip-types" || arg === "--enable-source-maps",
        ),
      },
    );
  // A PG SyncRep wait cannot block preparation, runtime callbacks or writes for
  // other repositories. SQLite acceptance is bounded in-process WAL work.
  const dedicated = daemonWriterSupportsCommitPhase(bootstrap.config.storage),
    currentHost = dedicated ? createHost() : (host ??= createHost()),
    channel = new MessageChannel(),
    nativePost = writer.postMessage.bind(writer),
    commitState = new Int32Array(new SharedArrayBuffer(8));
  Atomics.store(commitState, 1, 1);
  const context = prepareStorageWorkerContext(bootstrap.config.storage, bootstrap.config.repoId);
  if (!dedicated) connections++;
  channel.port1.on("message", (message: { schema?: string; response?: import("node:worker_threads").MessagePort }) => {
    if (message.schema === "canonical-commit/v1") nativePost(message, [message.response!]);
    else if (message.schema === "canonical-writer-crash/v1") nativePost(message);
    else writer.emit("message", message);
  });
  const hostFailure = (error: Error) => writer.emit("error", error);
  currentHost.on("error", hostFailure);
  writer.once("exit", () => {
    Atomics.store(commitState, 1, 0);
    Atomics.store(commitState, 0, -1);
    Atomics.notify(commitState, 0);
    channel.port1.close();
    context.close();
    currentHost.off("error", hostFailure);
    if (dedicated) void currentHost.terminate();
    else if (--connections === 0) {
      host = undefined;
      void currentHost.terminate();
    }
  });
  writer.postMessage = (message: unknown, transferList) => {
    const schema = (message as { schema?: string } | null)?.schema;
    if (schema?.startsWith("harness-repo-writer-")) {
      writer.emit("orchestration-post", message);
      channel.port1.postMessage(message, transferList);
    } else nativePost(message, transferList);
  };
  currentHost.postMessage(
    {
      bootstrap: {
        ...bootstrap,
        storageContext: context.context,
        commitState: commitState.buffer as SharedArrayBuffer,
      },
      port: channel.port2,
    },
    [channel.port2, ...context.transferList],
  );
}
