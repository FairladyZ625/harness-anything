/** Single-writer/single-reader completion samples on the existing shared-memory diagnostics path. */
export interface DaemonTraceCompletion {
  readonly method: string;
  readonly nodeId: string | null;
  readonly endedAtMs: number;
  readonly durationMs: number;
  readonly ok: boolean;
}
const HEADER_BYTES = 64,
  SLOT_BYTES = 1_056,
  TEXT_UNITS = 256,
  WRITE = 0,
  READ = 1,
  DROPPED = 2;

/** The producer never waits or overwrites unread samples; conn-log remains the full request record. */
export function createDaemonTraceCompletions(capacity = 16_384) {
  // Power-of-two capacity keeps slot indexing continuous across the uint32 sequence wrap.
  if (!Number.isInteger(capacity) || capacity < 1 || (capacity & -capacity) !== capacity)
    throw new RangeError("Completion capacity must be a positive power of two");
  const buffer = new SharedArrayBuffer(HEADER_BYTES + capacity * SLOT_BYTES),
    header = new Int32Array(buffer, 0, HEADER_BYTES / 4),
    numbers = new Float64Array(buffer),
    chars = new Uint16Array(buffer);
  return {
    buffer,
    record(sample: DaemonTraceCompletion): void {
      const write = Atomics.load(header, WRITE) >>> 0,
        read = Atomics.load(header, READ) >>> 0;
      if ((write - read) >>> 0 >= capacity) {
        Atomics.add(header, DROPPED, 1);
        return;
      }
      const base = HEADER_BYTES + (write % capacity) * SLOT_BYTES,
        offset = base / 8,
        method = sample.method.slice(0, TEXT_UNITS),
        node = sample.nodeId?.slice(0, TEXT_UNITS) ?? null;
      numbers[offset] = sample.endedAtMs;
      numbers[offset + 1] = sample.durationMs;
      numbers[offset + 2] = sample.ok ? 1 : 0;
      const text = base / 2 + 12;
      chars[text] = method.length;
      chars[text + 1] = node === null ? TEXT_UNITS + 1 : node.length;
      for (let index = 0; index < method.length; index++) chars[text + 2 + index] = method.charCodeAt(index);
      for (let index = 0; index < (node?.length ?? 0); index++)
        chars[text + 2 + TEXT_UNITS + index] = node!.charCodeAt(index);
      // Release only after the entire slot is written. Reader releases it before we reuse it.
      Atomics.store(header, WRITE, (write + 1) | 0);
    },
  };
}

export function readDaemonTraceCompletions(buffer: SharedArrayBuffer) {
  const header = new Int32Array(buffer, 0, HEADER_BYTES / 4),
    numbers = new Float64Array(buffer),
    chars = new Uint16Array(buffer),
    capacity = (buffer.byteLength - HEADER_BYTES) / SLOT_BYTES;
  return {
    /** Drain a finite published prefix; arrivals during this read belong to the next drain. */
    drain(consume: (sample: DaemonTraceCompletion) => void): void {
      let read = Atomics.load(header, READ) >>> 0;
      const write = Atomics.load(header, WRITE) >>> 0;
      while (read !== write) {
        const base = HEADER_BYTES + (read % capacity) * SLOT_BYTES,
          offset = base / 8,
          text = base / 2 + 12,
          nodeLength = chars[text + 1]!;
        const sample = {
          endedAtMs: numbers[offset]!,
          durationMs: numbers[offset + 1]!,
          ok: numbers[offset + 2] === 1,
          method: String.fromCharCode(...chars.subarray(text + 2, text + 2 + chars[text]!)),
          nodeId:
            nodeLength === TEXT_UNITS + 1
              ? null
              : String.fromCharCode(...chars.subarray(text + 2 + TEXT_UNITS, text + 2 + TEXT_UNITS + nodeLength)),
        };
        read = (read + 1) >>> 0;
        Atomics.store(header, READ, read | 0);
        consume(sample);
      }
    },
    get dropped(): number {
      return Atomics.load(header, DROPPED) >>> 0;
    },
  };
}
