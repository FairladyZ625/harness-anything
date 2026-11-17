import { syncBuiltinESMExports } from "node:module";
import threads, { type Worker, type WorkerOptions } from "node:worker_threads";
import { connectRepoWriterHost } from "../../src/daemon-host/repo-writer-host.ts";

/** Instrument the real host constructor for a single synchronous connection, without a production hook. */
export function probedOrchestrationHost(
  options: (value: WorkerOptions) => WorkerOptions,
): typeof connectRepoWriterHost {
  return (writer, bootstrap) => {
    const NativeWorker = threads.Worker;
    threads.Worker = class extends NativeWorker {
      constructor(filename: string | URL, value: WorkerOptions = {}) {
        super(filename, options(value));
        // Preload diagnostics use the physical host's parent port; preserve the
        // test's existing observation point on the supervised canonical Worker.
        this.on("message", (message: unknown) => writer.emit("message", message));
      }
    } as typeof Worker;
    syncBuiltinESMExports();
    try {
      connectRepoWriterHost(writer, bootstrap);
    } finally {
      threads.Worker = NativeWorker;
      syncBuiltinESMExports();
    }
  };
}
