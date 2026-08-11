import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const DECISION_RECEIPT_HMAC_KEY = "harness-anything/rebuild-gates/placeholder-hmac-v1";
const BASE64URL = /^[0-9A-Za-z_-]+$/u;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const DECISION_ID = /^dec_[0-9A-Za-z]+$/u;
const HEAD_SHA = /^[0-9a-f]{40}$/u;
const SIGNATURE = /^[0-9a-f]{64}$/u;

export const RECEIPT_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  oneOf: [
    {
      required: ["decisionId", "scope", "kind", "limit", "expiry", "signature"],
      properties: {
        decisionId: { type: "string", pattern: "^dec_[0-9A-Za-z]+$" },
        scope: { type: "string", minLength: 1 },
        kind: { type: "string", minLength: 1 },
        limit: { type: ["integer", "string"] },
        expiry: { type: "string", format: "date-time" },
        signature: { type: "string", pattern: "^[0-9a-f]{64}$" }
      },
      additionalProperties: false
    },
    {
      required: ["scope", "kind", "verdict", "headSha", "expiry", "signature"],
      properties: {
        scope: { type: "string", minLength: 1 },
        kind: { const: "anti-entropy-review" },
        verdict: { enum: ["approved", "pending", "rejected"] },
        headSha: { type: "string", pattern: "^[0-9a-f]{40}$" },
        expiry: { type: "string", format: "date-time" },
        signature: { type: "string", pattern: "^[0-9a-f]{64}$" }
      },
      additionalProperties: false
    }
  ]
});

// Decision receipts are committed on the trusted base side, so their P2 seam
// remains independent from G35's secret-backed anti-entropy verifier.
export function receiptVerificationKey() {
  return Buffer.from(DECISION_RECEIPT_HMAC_KEY, "utf8");
}

export function antiEntropyVerificationKey(environment = process.env) {
  const value = environment.ANTI_ENTROPY_HMAC_KEY;
  return typeof value === "string" && Buffer.byteLength(value, "utf8") > 0 ? Buffer.from(value, "utf8") : null;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

export function canonicalReceiptPayload(receipt) {
  const { signature: _signature, ...unsigned } = receipt;
  return JSON.stringify(canonicalValue(unsigned));
}

export function signReceipt(receipt, key = receiptVerificationKey()) {
  return createHmac("sha256", key).update(canonicalReceiptPayload(receipt)).digest("hex");
}

export function encodeReceiptToken(receipt) {
  return Buffer.from(JSON.stringify(receipt), "utf8").toString("base64url");
}

export function decodeReceiptToken(token) {
  if (typeof token !== "string" || token.length === 0 || !BASE64URL.test(token) || token.length % 4 === 1) {
    return { receipt: null, errors: ["anti-entropy token must be unpadded base64url"] };
  }

  const bytes = Buffer.from(token, "base64url");
  if (bytes.toString("base64url") !== token) {
    return { receipt: null, errors: ["anti-entropy token is not canonical base64url"] };
  }

  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { receipt: JSON.parse(json), errors: [] };
  } catch {
    return { receipt: null, errors: ["anti-entropy token must decode to UTF-8 receipt JSON"] };
  }
}

export function validateReceiptSchema(receipt) {
  const errors = [];
  if (!isPlainObject(receipt)) return ["receipt must be a JSON object"];

  const commonKeys = ["scope", "kind", "expiry", "signature"];
  for (const key of commonKeys) {
    if (typeof receipt[key] !== "string" || receipt[key].length === 0) errors.push(`${key} must be a non-empty string`);
  }
  if (typeof receipt.scope === "string" && /[\r\n]/u.test(receipt.scope)) errors.push("scope must be one line");
  if (typeof receipt.expiry === "string" && (!ISO_DATE_TIME.test(receipt.expiry) || Number.isNaN(Date.parse(receipt.expiry)))) errors.push("expiry must be an RFC 3339 UTC timestamp");
  if (typeof receipt.signature === "string" && !SIGNATURE.test(receipt.signature)) errors.push("signature must be 64 lowercase hexadecimal characters");

  const isDecision = Object.hasOwn(receipt, "decisionId") || Object.hasOwn(receipt, "limit");
  const allowed = isDecision
    ? new Set(["decisionId", "scope", "kind", "limit", "expiry", "signature"])
    : new Set(["scope", "kind", "verdict", "headSha", "expiry", "signature"]);
  for (const key of Object.keys(receipt)) {
    if (!allowed.has(key)) errors.push(`unexpected field: ${key}`);
  }

  if (isDecision) {
    if (typeof receipt.decisionId !== "string" || !DECISION_ID.test(receipt.decisionId)) errors.push("decisionId must match dec_<id>");
    if (!(Number.isInteger(receipt.limit) && receipt.limit >= 0) && !(typeof receipt.limit === "string" && receipt.limit.length > 0)) {
      errors.push("limit must be a non-negative integer or non-empty string");
    }
  } else {
    if (receipt.kind !== "anti-entropy-review") errors.push("review receipt kind must be anti-entropy-review");
    if (!["approved", "pending", "rejected"].includes(receipt.verdict)) errors.push("verdict must be approved, pending, or rejected");
    if (typeof receipt.headSha !== "string" || !HEAD_SHA.test(receipt.headSha)) errors.push("headSha must be a full lowercase commit SHA");
  }

  return errors;
}

export function verifyReceipt(receipt, expectations = {}) {
  const errors = validateReceiptSchema(receipt);
  if (errors.length === 0) {
    const key = expectations.key ?? (receipt.kind === "anti-entropy-review" ? null : receiptVerificationKey());
    if (key === null) {
      errors.push("anti-entropy verification key is required");
    } else {
      const supplied = Buffer.from(receipt.signature, "hex");
      const expected = Buffer.from(signReceipt(receipt, key), "hex");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) errors.push("signature does not match receipt payload");
    }
  }

  const now = expectations.now instanceof Date ? expectations.now : new Date(expectations.now ?? Date.now());
  if (typeof receipt?.expiry === "string" && !Number.isNaN(Date.parse(receipt.expiry)) && Date.parse(receipt.expiry) <= now.getTime()) {
    errors.push(`receipt expired at ${receipt.expiry}`);
  }
  if (expectations.maximumTtlMs !== undefined
    && typeof receipt?.expiry === "string"
    && !Number.isNaN(Date.parse(receipt.expiry))
    && Date.parse(receipt.expiry) > now.getTime() + expectations.maximumTtlMs) {
    errors.push(`receipt expiry exceeds maximum TTL of ${expectations.maximumTtlMs}ms`);
  }
  if (expectations.scope !== undefined && receipt?.scope !== expectations.scope) errors.push(`scope must be ${expectations.scope}`);
  if (expectations.kind !== undefined && receipt?.kind !== expectations.kind) errors.push(`kind must be ${expectations.kind}`);
  if (expectations.decisionId !== undefined && receipt?.decisionId !== expectations.decisionId) errors.push(`decisionId must be ${expectations.decisionId}`);
  if (expectations.headSha !== undefined && receipt?.headSha !== expectations.headSha) errors.push(`headSha must be ${expectations.headSha}`);
  if (expectations.verdict !== undefined && receipt?.verdict !== expectations.verdict) errors.push(`verdict must be ${expectations.verdict}`);
  if (expectations.limit !== undefined && receipt?.limit !== expectations.limit) errors.push(`limit must be ${expectations.limit}`);
  if (expectations.minimumLimit !== undefined && !(typeof receipt?.limit === "number" && receipt.limit >= expectations.minimumLimit)) {
    errors.push(`limit must be at least ${expectations.minimumLimit}`);
  }
  return { ok: errors.length === 0, errors };
}

export function loadReceipts(receiptsDir) {
  try {
    return readdirSync(receiptsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => {
        const filePath = path.join(receiptsDir, entry.name);
        return { filePath, receipt: JSON.parse(readFileSync(filePath, "utf8")) };
      });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
