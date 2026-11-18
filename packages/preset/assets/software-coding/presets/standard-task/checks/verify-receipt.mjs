import { readFileSync } from "node:fs";

const PREDICATE_TYPE = "software-coding/verification-receipt/v1";
/** Match only package-root artifacts/verification-receipt.json so nested archive copies cannot shadow it. */
const ROOT_RECEIPT_PATTERN = /^(?:(?!artifacts\/)[^/]+\/)*artifacts\/verification-receipt\.json$/u;
const REQUIRED_FIELDS = ["commitSha", "passed", "failed", "timedOut", "unexecuted", "total"];
const COUNT_FIELDS = ["passed", "failed", "timedOut", "unexecuted", "total"];
const MAX_FAIL_FRAME_BYTES = 960;

function describeValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `array(length=${value.length})`;
  if (typeof value === "object") return "object";
  if (typeof value === "string") {
    return /^[0-9a-f]{40}$/u.test(value) ? JSON.stringify(value) : `string(length=${value.length})`;
  }
  const text = String(value);
  return text.length <= 32 ? text : `${typeof value}(length=${text.length})`;
}

function serializeFrame(result, subjects, predicate, diagnostic) {
  return JSON.stringify({
    schema: "preset-script-result/v1",
    produces: [
      {
        capabilityId: "completion-witness",
        payload: {
          result,
          subjects,
          predicateType: PREDICATE_TYPE,
          predicate,
          diagnostic,
        },
      },
    ],
  });
}

function emit(result, subjects, predicate, diagnostic) {
  let boundedDiagnostic = diagnostic;
  let frame = serializeFrame(result, subjects, predicate, boundedDiagnostic);
  if (result === "fail" && Buffer.byteLength(frame, "utf8") + 1 > MAX_FAIL_FRAME_BYTES) {
    let low = 0;
    let high = boundedDiagnostic.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const candidate = `${boundedDiagnostic.slice(0, mid)}...`;
      if (
        Buffer.byteLength(serializeFrame(result, subjects, predicate, candidate), "utf8") + 1 <=
        MAX_FAIL_FRAME_BYTES
      ) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    boundedDiagnostic = low > 0 ? `${boundedDiagnostic.slice(0, low)}...` : "Invalid verification receipt.";
    frame = serializeFrame(result, subjects, predicate, boundedDiagnostic);
  }
  console.log(frame);
}

const presetInput = JSON.parse(process.env.HA_PRESET_INPUT ?? "{}");
const witnessInput = JSON.parse(readFileSync(presetInput.witnessInput, "utf8"));
const subjects = (witnessInput.subjects ?? []).map(({ file: _file, ...identity }) => identity);

const receiptSubject = (witnessInput.subjects ?? []).find((item) => ROOT_RECEIPT_PATTERN.test(item.path));

if (!receiptSubject) {
  emit("fail", subjects, {}, "Missing required verification receipt artifact: artifacts/verification-receipt.json.");
  process.exit(0);
}

const rawFieldSources = new WeakMap();
let receipt;
try {
  receipt = JSON.parse(readFileSync(receiptSubject.file, "utf8"), function (key, value, context) {
    if (this && typeof this === "object" && typeof context?.source === "string") {
      let entries = rawFieldSources.get(this);
      if (!entries) {
        entries = new Map();
        rawFieldSources.set(this, entries);
      }
      entries.set(key, context.source);
    }
    return value;
  });
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  emit("fail", subjects, {}, `Invalid JSON in artifacts/verification-receipt.json: ${detail}`);
  process.exit(0);
}

if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
  emit("fail", subjects, {}, "artifacts/verification-receipt.json must contain a JSON object.");
  process.exit(0);
}

const errors = [];

for (const field of REQUIRED_FIELDS) {
  if (!Object.hasOwn(receipt, field)) errors.push(`Missing required field "${field}".`);
}

if (witnessInput.code !== null) {
  const expectedSha = witnessInput.code?.commitSha;
  if (typeof receipt.commitSha !== "string" || receipt.commitSha !== expectedSha) {
    errors.push(
      `Receipt commitSha (${describeValue(receipt.commitSha)}) does not match frozen commitSha (${String(expectedSha)}).`,
    );
  }
} else if (Object.hasOwn(receipt, "commitSha") && receipt.commitSha !== null) {
  errors.push(`Artifact-only submission requires commitSha to be null (got ${describeValue(receipt.commitSha)}).`);
}

const rootSources = rawFieldSources.get(receipt);
let countsValid = true;
for (const field of COUNT_FIELDS) {
  if (!Object.hasOwn(receipt, field)) {
    countsValid = false;
    continue;
  }
  const value = receipt[field];
  const rawSource = rootSources?.get(field);
  const exactInteger =
    Number.isSafeInteger(value) &&
    value >= 0 &&
    (typeof rawSource !== "string" || (/^(?:0|[1-9]\d*)$/u.test(rawSource) && String(value) === rawSource));
  if (!exactInteger) {
    countsValid = false;
    const shown =
      typeof value === "number" && typeof rawSource === "string" && rawSource.length <= 32
        ? rawSource
        : describeValue(value);
    errors.push(`Field "${field}" must be a non-negative safe integer (got ${shown}).`);
  }
}

if (countsValid) {
  if (receipt.total <= 0) {
    errors.push(`Field "total" must be greater than 0 (got ${receipt.total}).`);
  }
  const sum = receipt.passed + receipt.failed + receipt.timedOut + receipt.unexecuted;
  if (sum !== receipt.total) {
    errors.push(
      `Four-state count sum mismatch: passed(${receipt.passed}) + failed(${receipt.failed}) + timedOut(${receipt.timedOut}) + unexecuted(${receipt.unexecuted}) = ${sum} !== total(${receipt.total}).`,
    );
  }
  if (receipt.failed > 0 || receipt.timedOut > 0 || receipt.unexecuted > 0) {
    errors.push(
      `Non-passing outcomes present: failed=${receipt.failed}, timedOut=${receipt.timedOut}, unexecuted=${receipt.unexecuted} (all must be 0).`,
    );
  }
}

if (errors.length > 0) {
  emit("fail", subjects, {}, errors.join(" "));
} else {
  const predicate = {
    commitSha: receipt.commitSha,
    passed: receipt.passed,
    failed: receipt.failed,
    timedOut: receipt.timedOut,
    unexecuted: receipt.unexecuted,
    total: receipt.total,
  };
  emit("pass", subjects, predicate, "Verification receipt verified: commitSha and four-state counts match frozen cut.");
}
