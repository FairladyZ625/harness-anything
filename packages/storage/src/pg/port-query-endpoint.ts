import { EventEmitter } from "node:events";
import type { MessagePort } from "node:worker_threads";
import type { PgQueryEndpoint } from "./pg-task-query-reader.ts";

export class PortQueryEndpoint extends EventEmitter implements PgQueryEndpoint {
  private readonly port: MessagePort;
  constructor(port: MessagePort) {
    super();
    this.port = port;
    port.on("close", () => this.emit("exit", 0));
    port.on("messageerror", (error: Error) => this.emit("error", error));
  }
  postMessage(value: unknown): void {
    this.port.postMessage(value);
  }
  terminate(): void {
    this.port.close();
  }
  unref(): void {
    this.port.unref();
  }
}
