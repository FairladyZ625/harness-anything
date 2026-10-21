// Cross-process steering channel for a live runtime: the dispatch stream is the command
// transport. The daemon appends a `steer_requested` record; the worker host that owns the
// provider follows the same file and applies it. No in-memory handle is involved, so a host
// adopted after a daemon restart — or one launched behind the writer thread — is steerable
// exactly like a host this daemon spawned itself.
import { statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { parseRecord, readRuntimeWorkerChunk } from "./dispatch-stream.ts";

// One poll interval mirrors the adoption drain: provider output is already read this way, and
// a steering prompt tolerates sub-second latency.
const steerPollIntervalMs = 250;

export interface RuntimeSteerTail {
  readonly stop: () => void;
}

export function tailRuntimeSteerCommands(target: string, onSteer: (prompt: string) => void): RuntimeSteerTail {
  const decoder = new StringDecoder("utf8");
  // Start at the current end: the stream's earlier records are history this host did not
  // receive as commands, and re-reading a provider transcript would grow with the runtime.
  let offset = statSync(target, { throwIfNoEntry: false })?.size ?? 0,
    tail = "",
    stopped = false;
  const drain = (): void => {
    if (stopped) return;
    // Monotone `offset`, terminated by the reader's own empty chunk: a stream past the
    // provider transcript keeps growing, so no size or record count can end this loop.
    for (;;) {
      const bytes = readRuntimeWorkerChunk(target, offset);
      if (bytes.length === 0) break;
      offset += bytes.length;
      tail += decoder.write(bytes);
      const lines = tail.split(/\r?\n/u);
      tail = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const record = parseRecord(line);
        if (record?.kind !== "steer_requested" || typeof record.prompt !== "string") continue;
        onSteer(record.prompt);
      }
    }
  };
  const timer = setInterval(drain, steerPollIntervalMs);
  timer.unref();
  queueMicrotask(drain);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
