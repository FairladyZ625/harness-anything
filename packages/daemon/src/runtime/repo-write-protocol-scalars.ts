export interface RepoWriteEncodedBigInt {
  readonly $repoWriteType: "bigint";
  readonly encoding: "decimal";
  readonly text: string;
}

export interface RepoWriteEncodedBytes {
  readonly $repoWriteType: "bytes";
  readonly encoding: "base64url";
  readonly text: string;
}

export class RepoWriteProtocolDecodeError extends Error {
  readonly code: "REPO_WRITE_PROTOCOL_INVALID" | "REPO_WRITE_PROTOCOL_LIMIT";

  constructor(code: RepoWriteProtocolDecodeError["code"], message: string) {
    super(message);
    this.name = "RepoWriteProtocolDecodeError";
    this.code = code;
  }
}

export function encodeRepoWriteBigInt(value: bigint): RepoWriteEncodedBigInt {
  return { $repoWriteType: "bigint", encoding: "decimal", text: value.toString(10) };
}

export function decodeRepoWriteBigInt(value: unknown): bigint {
  const record = scalarRecord(value);
  if (Object.keys(record).length !== 3
    || record.$repoWriteType !== "bigint"
    || record.encoding !== "decimal"
    || typeof record.text !== "string"
    || !/^(?:0|-[1-9]\d*|[1-9]\d*)$/u.test(record.text)
    || record.text.length > 4_096) {
    scalarInvalid("encoded bigint");
  }
  return BigInt(record.text);
}

export function encodeRepoWriteBytes(value: Uint8Array): RepoWriteEncodedBytes {
  return {
    $repoWriteType: "bytes",
    encoding: "base64url",
    text: Buffer.from(value).toString("base64url")
  };
}

export function decodeRepoWriteBytes(value: unknown): Uint8Array {
  const record = scalarRecord(value);
  if (Object.keys(record).length !== 3
    || record.$repoWriteType !== "bytes"
    || record.encoding !== "base64url"
    || typeof record.text !== "string"
    || !/^[A-Za-z0-9_-]*$/u.test(record.text)) {
    scalarInvalid("encoded bytes");
  }
  const decoded = Buffer.from(record.text, "base64url");
  if (decoded.toString("base64url") !== record.text) scalarInvalid("encoded bytes");
  return new Uint8Array(decoded);
}

function scalarRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    scalarInvalid("encoded scalar object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    scalarInvalid("plain encoded scalar object");
  }
  return value as Record<string, unknown>;
}

function scalarInvalid(expected: string): never {
  throw new RepoWriteProtocolDecodeError(
    "REPO_WRITE_PROTOCOL_INVALID",
    `Invalid repo writer IPC at $: expected ${expected}.`
  );
}
