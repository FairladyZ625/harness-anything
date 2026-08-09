import { createHash } from "node:crypto";

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function stablePayloadHash(value: unknown): string {
  return sha256Text(stableStringify(value));
}

export function stableStringify(value: unknown): string {
  // Mirror JSON.stringify semantics for non-JSON values: undefined-valued
  // object keys are omitted and undefined array items become null. For
  // scalars JSON.stringify already returns undefined for undefined, function,
  // and symbol; interpolating that result verbatim wrote the literal text
  // `undefined` into persisted records, producing unparseable JSON.
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item) ?? "null").join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .flatMap((key) => {
      const text = stableStringify(record[key]);
      return text === undefined ? [] : [`${JSON.stringify(key)}:${text}`];
    })
    .join(",")}}`;
}
