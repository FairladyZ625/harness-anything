import { randomUUID } from "node:crypto";
import { BroadcastChannel, getEnvironmentData, setEnvironmentData, threadId, type Worker } from "node:worker_threads";

const channelKey = "harness-daemon-memory-ledger";
type Heap = { heapTotal: number; heapUsed: number; external: number };
type Isolate = {
  threadId: number;
  role: string;
  sampledAt: number | null;
  heap: Heap | null;
  sampleError: string | null;
};
type Inventory = { parent: number; isolates: Isolate[] };

/** Observe children where they are created, including workers created inside writer/diagnostics isolates.
 * getHeapStatistics schedules a V8 sample on that isolate; a stalled worker stays explicitly unsampled
 * or stale. No wait for it can block the main heartbeat or the independent diagnostic socket.
 */
export function observeWorkerMemory(channelName = getEnvironmentData(channelKey) as string | undefined) {
  const channel = channelName ? new BroadcastChannel(channelName) : null,
    children = new Map<Worker, Isolate>(),
    sampling = new Set<Worker>(),
    inventories = new Map<number, Isolate[]>();
  let closed = false;
  const sendInventory = (): void => {
    if (closed) return;
    const inventory: Inventory = { parent: threadId, isolates: [...children.values()] };
    inventories.set(threadId, inventory.isolates);
    channel?.postMessage(inventory);
  };
  const refresh = (): void => {
    if (closed) return;
    sendInventory();
    for (const [worker, row] of children) {
      if (sampling.has(worker)) continue;
      sampling.add(worker);
      void worker
        .getHeapStatistics()
        .then(
          (heap) => {
            if (!children.has(worker)) return;
            row.heap = {
              heapTotal: heap.total_heap_size,
              heapUsed: heap.used_heap_size,
              external: heap.external_memory,
            };
            row.sampledAt = Date.now();
            row.sampleError = null;
            sendInventory();
          },
          (error: unknown) => {
            if (!children.has(worker)) return;
            row.sampleError = error instanceof Error ? error.message : String(error);
            sendInventory();
          },
        )
        .finally(() => sampling.delete(worker));
    }
  };
  const created = (worker: Worker): void => {
    children.set(worker, {
      threadId: worker.threadId,
      role: worker.threadName ?? "worker",
      sampledAt: null,
      heap: null,
      sampleError: null,
    });
    worker.once("exit", () => {
      children.delete(worker);
      sampling.delete(worker);
      sendInventory();
    });
    refresh();
  };
  if (channel) process.on("worker", created);
  if (channel)
    channel.onmessage = ({ data }: { data: Inventory | "sample" }) => {
      if (data === "sample") refresh();
      else inventories.set(data.parent, data.isolates);
    };
  channel?.unref();
  return {
    sample: () => {
      channel?.postMessage("sample");
      refresh();
    },
    snapshot: (main: NodeJS.MemoryUsage) => {
      const isolates: Isolate[] = [],
        visited = new Set<number>([threadId]),
        parents = [threadId];
      // Only reachable live children count: a retiring parent removes its complete subtree.
      for (let index = 0; index < parents.length; index++) {
        for (const row of inventories.get(parents[index]!) ?? []) {
          if (visited.has(row.threadId)) continue;
          visited.add(row.threadId);
          parents.push(row.threadId);
          isolates.push(row);
        }
      }
      for (const parent of inventories.keys()) if (!visited.has(parent)) inventories.delete(parent);
      const total: Heap = { heapTotal: 0, heapUsed: 0, external: 0 },
        byRole = new Map<string, { active: number; sampled: number } & Heap>();
      for (const row of isolates) {
        let role = byRole.get(row.role);
        if (!role) {
          role = { active: 0, sampled: 0, heapTotal: 0, heapUsed: 0, external: 0 };
          byRole.set(row.role, role);
        }
        role.active++;
        if (!row.heap) continue;
        role.sampled++;
        for (const key of ["heapTotal", "heapUsed", "external"] as const) {
          total[key] += row.heap[key];
          role[key] += row.heap[key];
        }
      }
      return {
        rss: main.rss,
        mainThread: {
          heapTotal: main.heapTotal,
          heapUsed: main.heapUsed,
          external: main.external,
          arrayBuffers: main.arrayBuffers,
        },
        workers: {
          active: isolates.length,
          sampled: isolates.filter((row) => row.heap !== null).length,
          ...total,
          byRole: Object.fromEntries(byRole),
          isolates,
        },
        // arrayBuffers is a subset of external (Node process.memoryUsage contract), never an addend.
        // Shared backing stores and allocator/code pages also prevent interpreting this as RSS attribution.
        allThreads: {
          heapTotal: main.heapTotal + total.heapTotal,
          heapUsed: main.heapUsed + total.heapUsed,
          external: main.external + total.external,
        },
      };
    },
    close: () => {
      closed = true;
      process.off("worker", created);
      channel?.close();
    },
  };
}

/** Must start before spawning the observer itself, so its isolate is also included. */
export function openDaemonMemoryLedger() {
  const previous = getEnvironmentData(channelKey),
    name = `harness-memory-${randomUUID()}`;
  setEnvironmentData(channelKey, name);
  const ledger = observeWorkerMemory(name);
  return {
    ...ledger,
    close: () => {
      ledger.close();
      setEnvironmentData(channelKey, previous);
    },
  };
}
