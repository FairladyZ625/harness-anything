import { installStorageWorkerContext } from "@harness-anything/storage";
import { EventEmitter } from "node:events";
import { parentPort, type MessagePort, type Worker } from "node:worker_threads";
import { connectRepoWriterHost } from "./repo-orchestration-host.ts";
import type { RepoWriterBootstrapV1 } from "./repo-writer-protocol.ts";
import { observeWorkerMemory } from "../writer-cell/daemon-diagnostics-memory.ts";

observeWorkerMemory();
if (!parentPort) throw new Error("Repository orchestration requires a Worker");
parentPort.on("message", ({ bootstrap, port }: { bootstrap: RepoWriterBootstrapV1; port: MessagePort }) => {
  installStorageWorkerContext(bootstrap.storageContext);
  const endpoint = new EventEmitter() as Worker;
  endpoint.postMessage = (message: { schema?: string; response?: MessagePort }, transferList) =>
    port.postMessage(message, message.schema === "canonical-commit/v1" ? [message.response!] : transferList);
  endpoint.on("message", (message: unknown) => port.postMessage(message));
  connectRepoWriterHost(endpoint, bootstrap);
  port.on("message", (message: unknown) => endpoint.postMessage(message));
  port.on("close", () => endpoint.postMessage({ schema: "repo-orchestration-disconnected/v1" }));
});
