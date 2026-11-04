/**
 * In-flight operation state shared with the watchdog worker.
 *
 * The main thread owns the slots and the watchdog only reads them. Publishing a registration is a
 * few writes into a SharedArrayBuffer instead of three cross-thread messages, and the state is
 * visible even when the main thread blocks immediately afterwards — which is exactly the stall the
 * watchdog has to describe. Each slot uses a seqlock: writers keep `version` odd while mutating and
 * readers retry when the version changed underneath them.
 */
const TEXT_CODE_UNITS = 256,
  TEXT_BYTES = TEXT_CODE_UNITS * 2,
  HEADER_BYTES = 64,
  SLOT_HEADER_BYTES = 64,
  SLOT_BYTES = SLOT_HEADER_BYTES + TEXT_BYTES * 4,
  DEFAULT_CAPACITY = 2_048,
  ACTIVE_COUNT = 0,
  OVERFLOW_COUNT = 1,
  CAPACITY = 2,
  STATE = 0,
  VERSION = 4,
  ID = 8,
  STARTED_AT = 16,
  METHOD_LENGTH = 24,
  REPO_LENGTH = 28,
  ACTOR_LENGTH = 32,
  PHASE_LENGTH = 36,
  METHOD_TEXT = 64,
  REPO_TEXT = METHOD_TEXT + TEXT_BYTES,
  ACTOR_TEXT = REPO_TEXT + TEXT_BYTES,
  PHASE_TEXT = ACTOR_TEXT + TEXT_BYTES,
  FREE = 0,
  ACTIVE = 2;

export interface DaemonOperationBeginFields {
  readonly method: string;
  readonly repoId?: string | null;
  readonly actor?: string | null;
  readonly phase?: string;
}
export interface DaemonOperationUpdateFields {
  readonly phase?: string;
  readonly repoId?: string | null;
  readonly actor?: string | null;
}
export interface DaemonOperationRegistration {
  readonly update: (fields: DaemonOperationUpdateFields) => void;
  readonly end: () => void;
}
export interface DaemonOperationTable {
  readonly buffer: SharedArrayBuffer;
  readonly capacity: number;
  readonly begin: (fields: DaemonOperationBeginFields) => DaemonOperationRegistration;
  readonly activeCount: number;
  readonly overflowCount: number;
}
export interface DaemonOperationInFlight {
  readonly id: string;
  readonly method: string;
  readonly repoId: string | null;
  readonly actor: string | null;
  readonly startedAt: string;
  readonly phase: string;
}
export interface DaemonOperationTableReader {
  readonly snapshot: () => DaemonOperationInFlight[];
  readonly activeCount: number;
  readonly overflowCount: number;
}
const noop: DaemonOperationRegistration = { update: () => {}, end: () => {} };

function truncate(value: string): string {
  return value.length > TEXT_CODE_UNITS ? value.slice(0, TEXT_CODE_UNITS) : value;
}

function writeText(
  int32: Int32Array,
  chars: Uint16Array,
  slotBase: number,
  lengthOffset: number,
  textOffset: number,
  value: string | null,
): void {
  const lengthIndex = (slotBase + lengthOffset) / 4;
  if (value === null) {
    int32[lengthIndex] = -1;
    return;
  }
  const text = truncate(value),
    textStart = (slotBase + textOffset) / 2;
  int32[lengthIndex] = text.length;
  for (let index = 0; index < text.length; index++) chars[textStart + index] = text.charCodeAt(index);
}

function readText(
  int32: Int32Array,
  chars: Uint16Array,
  slotBase: number,
  lengthOffset: number,
  textOffset: number,
): string | null {
  const length = int32[(slotBase + lengthOffset) / 4];
  if (length < 0) return null;
  if (length === 0) return "";
  const textStart = (slotBase + textOffset) / 2;
  return String.fromCharCode(...chars.subarray(textStart, textStart + Math.min(length, TEXT_CODE_UNITS)));
}

/** Create the shared table on the daemon side. Slots are handed out to concurrent operations. */
export function createDaemonOperationTable(capacity = DEFAULT_CAPACITY): DaemonOperationTable {
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`Operation table capacity: ${capacity}`);
  const buffer = new SharedArrayBuffer(HEADER_BYTES + capacity * SLOT_BYTES),
    int32 = new Int32Array(buffer),
    float64 = new Float64Array(buffer),
    chars = new Uint16Array(buffer),
    free = Array.from({ length: capacity }, (_, index) => capacity - 1 - index);
  int32[CAPACITY] = capacity;
  let lastId = 0,
    overflowReported = false;
  const begin = (fields: DaemonOperationBeginFields): DaemonOperationRegistration => {
    const slot = free.pop();
    if (slot === undefined) {
      Atomics.add(int32, OVERFLOW_COUNT, 1);
      if (!overflowReported) {
        overflowReported = true;
        process.stderr.write(`daemon diagnostics operation table full at ${capacity} in-flight operations\n`);
      }
      return noop;
    }
    const base = HEADER_BYTES + slot * SLOT_BYTES,
      stateIndex = base / 4 + STATE / 4,
      versionIndex = base / 4 + VERSION / 4;
    Atomics.store(int32, stateIndex, 1); // WRITING
    // Never reset the version: a reader that started against the previous use of this slot must see
    // it change rather than alias a fresh zero.
    Atomics.add(int32, versionIndex, 1);
    float64[(base + ID) / 8] = ++lastId;
    float64[(base + STARTED_AT) / 8] = Date.now();
    writeText(int32, chars, base, METHOD_LENGTH, METHOD_TEXT, fields.method);
    writeText(int32, chars, base, REPO_LENGTH, REPO_TEXT, fields.repoId ?? null);
    writeText(int32, chars, base, ACTOR_LENGTH, ACTOR_TEXT, fields.actor ?? null);
    writeText(int32, chars, base, PHASE_LENGTH, PHASE_TEXT, fields.phase ?? "started");
    Atomics.add(int32, versionIndex, 1);
    Atomics.add(int32, ACTIVE_COUNT, 1);
    Atomics.store(int32, stateIndex, ACTIVE);
    let ended = false;
    return {
      update: (update) => {
        if (ended) return;
        const { phase, repoId, actor } = update;
        if (phase === undefined && repoId === undefined && actor === undefined) return;
        Atomics.add(int32, versionIndex, 1);
        if (phase !== undefined) writeText(int32, chars, base, PHASE_LENGTH, PHASE_TEXT, phase);
        if (repoId !== undefined) writeText(int32, chars, base, REPO_LENGTH, REPO_TEXT, repoId);
        if (actor !== undefined) writeText(int32, chars, base, ACTOR_LENGTH, ACTOR_TEXT, actor);
        Atomics.add(int32, versionIndex, 1);
      },
      end: () => {
        if (ended) return;
        ended = true;
        Atomics.store(int32, stateIndex, FREE);
        Atomics.sub(int32, ACTIVE_COUNT, 1);
        free.push(slot);
      },
    };
  };
  return {
    buffer,
    capacity,
    begin,
    get activeCount() {
      return Atomics.load(int32, ACTIVE_COUNT);
    },
    get overflowCount() {
      return Atomics.load(int32, OVERFLOW_COUNT);
    },
  };
}

/** Read the table on the watchdog side without blocking or messaging the main thread. */
export function readDaemonOperationTable(buffer: SharedArrayBuffer): DaemonOperationTableReader {
  const int32 = new Int32Array(buffer),
    float64 = new Float64Array(buffer),
    chars = new Uint16Array(buffer),
    capacity = int32[CAPACITY];
  const snapshot = (): DaemonOperationInFlight[] => {
    const operations: DaemonOperationInFlight[] = [];
    for (let slot = 0; slot < capacity; slot++) {
      const base = HEADER_BYTES + slot * SLOT_BYTES,
        stateIndex = base / 4 + STATE / 4;
      if (Atomics.load(int32, stateIndex) !== ACTIVE) continue;
      // Writers publish state only after the fields are written, so a stable version is a full read.
      for (let attempt = 0; attempt < 4; attempt++) {
        const before = Atomics.load(int32, base / 4 + VERSION / 4);
        if (before % 2 !== 0) continue;
        const operation: DaemonOperationInFlight = {
          id: String(float64[(base + ID) / 8]),
          method: readText(int32, chars, base, METHOD_LENGTH, METHOD_TEXT) ?? "",
          repoId: readText(int32, chars, base, REPO_LENGTH, REPO_TEXT),
          actor: readText(int32, chars, base, ACTOR_LENGTH, ACTOR_TEXT),
          startedAt: new Date(float64[(base + STARTED_AT) / 8]).toISOString(),
          phase: readText(int32, chars, base, PHASE_LENGTH, PHASE_TEXT) ?? "started",
        };
        if (before === Atomics.load(int32, base / 4 + VERSION / 4) && Atomics.load(int32, stateIndex) === ACTIVE) {
          operations.push(operation);
          break;
        }
      }
    }
    return operations;
  };
  return {
    snapshot,
    get activeCount() {
      return Atomics.load(int32, ACTIVE_COUNT);
    },
    get overflowCount() {
      return Atomics.load(int32, OVERFLOW_COUNT);
    },
  };
}
