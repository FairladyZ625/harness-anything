import { createHash } from "node:crypto";
export type CanonicalCborValue =
  | null
  | boolean
  | string
  | number
  | bigint
  | Uint8Array
  | ReadonlyArray<CanonicalCborValue>
  | { readonly [key: string]: CanonicalCborValue };

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const maxUint64 = (1n << 64n) - 1n;

export function encodeCanonicalCbor(value: CanonicalCborValue): Uint8Array {
  return Buffer.concat(encodeValue(value));
}

export function decodeCanonicalCbor(bytes: Uint8Array): CanonicalCborValue {
  const decoder = new Decoder(bytes);
  const value = decoder.read();
  if (!decoder.done()) throw new Error("canonical CBOR has trailing bytes");
  return value;
}

export function canonicalCborBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function encodeValue(value: CanonicalCborValue): Buffer[] {
  if (value === null) return [Buffer.from([0xf6])];
  if (typeof value === "boolean") return [Buffer.from([value ? 0xf5 : 0xf4])];
  if (typeof value === "string") {
    const body = Buffer.from(value, "utf8");
    return [head(3, BigInt(body.length)), body];
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("canonical CBOR numbers must be safe integers");
    return encodeInteger(BigInt(value));
  }
  if (typeof value === "bigint") return encodeInteger(value);
  if (value instanceof Uint8Array) {
    const body = Buffer.from(value);
    return [head(2, BigInt(body.length)), body];
  }
  if (Array.isArray(value)) {
    return [head(4, BigInt(value.length)), ...value.flatMap((entry) => encodeValue(entry))];
  }
  if (!isCborRecord(value)) throw new Error("unsupported canonical CBOR value");
  const entries = Object.entries(value).map(([key, entry]) => {
    const encodedKey = Buffer.concat(encodeValue(key));
    return { encodedKey, encodedValue: Buffer.concat(encodeValue(entry)) };
  }).sort((left, right) => compareMapKeys(left.encodedKey, right.encodedKey));
  return [
    head(5, BigInt(entries.length)),
    ...entries.flatMap(({ encodedKey, encodedValue }) => [encodedKey, encodedValue])
  ];
}

function encodeInteger(value: bigint): Buffer[] {
  if (value >= 0n) return [head(0, value)];
  return [head(1, -1n - value)];
}

function head(major: number, value: bigint): Buffer {
  if (value < 0n || value > maxUint64) throw new Error("canonical CBOR integer exceeds uint64");
  if (value < 24n) return Buffer.from([(major << 5) | Number(value)]);
  if (value <= 0xffn) return Buffer.from([(major << 5) | 24, Number(value)]);
  if (value <= 0xffffn) {
    const bytes = Buffer.allocUnsafe(3);
    bytes[0] = (major << 5) | 25;
    bytes.writeUInt16BE(Number(value), 1);
    return bytes;
  }
  if (value <= 0xffff_ffffn) {
    const bytes = Buffer.allocUnsafe(5);
    bytes[0] = (major << 5) | 26;
    bytes.writeUInt32BE(Number(value), 1);
    return bytes;
  }
  const bytes = Buffer.allocUnsafe(9);
  bytes[0] = (major << 5) | 27;
  bytes.writeBigUInt64BE(value, 1);
  return bytes;
}

class Decoder {
  private offset = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  done(): boolean {
    return this.offset === this.bytes.length;
  }

  read(): CanonicalCborValue {
    const initial = this.byte();
    const major = initial >> 5;
    const additional = initial & 0x1f;
    if (additional === 31) throw new Error("indefinite-length CBOR is forbidden");
    if (major === 6) throw new Error("CBOR tags are forbidden");
    if (major === 7) return this.simple(additional);
    const argument = this.argument(additional);
    if (major === 0) return integerValue(argument);
    if (major === 1) return integerValue(-1n - argument);
    if (major === 2) return this.takeLength(argument);
    if (major === 3) return utf8Decoder.decode(this.takeLength(argument));
    if (major === 4) return this.array(argument);
    if (major === 5) return this.map(argument);
    throw new Error(`unsupported CBOR major type ${major}`);
  }

  private simple(additional: number): CanonicalCborValue {
    if (additional === 20) return false;
    if (additional === 21) return true;
    if (additional === 22) return null;
    throw new Error("CBOR floats, undefined, and unassigned simple values are forbidden");
  }

  private argument(additional: number): bigint {
    if (additional < 24) return BigInt(additional);
    if (additional === 24) {
      const value = BigInt(this.byte());
      if (value < 24n) throw new Error("non-shortest CBOR integer/length encoding");
      return value;
    }
    if (additional === 25) {
      const value = BigInt(this.take(2).readUInt16BE(0));
      if (value <= 0xffn) throw new Error("non-shortest CBOR integer/length encoding");
      return value;
    }
    if (additional === 26) {
      const value = BigInt(this.take(4).readUInt32BE(0));
      if (value <= 0xffffn) throw new Error("non-shortest CBOR integer/length encoding");
      return value;
    }
    if (additional === 27) {
      const value = this.take(8).readBigUInt64BE(0);
      if (value <= 0xffff_ffffn) throw new Error("non-shortest CBOR integer/length encoding");
      return value;
    }
    throw new Error("reserved CBOR additional information");
  }

  private array(length: bigint): CanonicalCborValue[] {
    const count = safeLength(length);
    return Array.from({ length: count }, () => this.read());
  }

  private map(length: bigint): { readonly [key: string]: CanonicalCborValue } {
    const count = safeLength(length);
    const output: Record<string, CanonicalCborValue> = {};
    let previousKeyBytes: Buffer | undefined;
    for (let index = 0; index < count; index += 1) {
      const keyStart = this.offset;
      const key = this.read();
      const keyBytes = Buffer.from(this.bytes.subarray(keyStart, this.offset));
      if (typeof key !== "string") throw new Error("canonical contract CBOR map keys must be text strings");
      if (previousKeyBytes && compareMapKeys(previousKeyBytes, keyBytes) >= 0) {
        throw new Error("CBOR map keys are duplicate or non-canonical");
      }
      previousKeyBytes = keyBytes;
      output[key] = this.read();
    }
    return output;
  }

  private byte(): number {
    if (this.offset >= this.bytes.length) throw new Error("truncated CBOR input");
    return this.bytes[this.offset++]!;
  }

  private takeLength(length: bigint): Buffer {
    return this.take(safeLength(length));
  }

  private take(length: number): Buffer {
    if (this.offset + length > this.bytes.length) throw new Error("truncated CBOR input");
    const output = Buffer.from(this.bytes.buffer, this.bytes.byteOffset + this.offset, length);
    this.offset += length;
    return output;
  }
}

function integerValue(value: bigint): number | bigint {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value;
}

function safeLength(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CBOR collection exceeds safe allocation limit");
  return Number(value);
}

function compareMapKeys(left: Uint8Array, right: Uint8Array): number {
  if (left.length !== right.length) return left.length - right.length;
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function isCborRecord(value: unknown): value is { readonly [key: string]: CanonicalCborValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array);
}

export function domainHash(domain: string, bytes: Uint8Array): Uint8Array {
  return createHash("sha256").update(domain, "utf8").update(bytes).digest();
}
