import { readFileSync } from "node:fs";

const PREDICATE_TYPE = "software-coding/verification-receipt/v1";
const ROOT_RECEIPT = /^(?:(?!artifacts\/)[^/]+\/)*artifacts\/verification-receipt\.json$/u;
const FIELDS = ["commitSha", "passed", "failed", "timedOut", "unexecuted", "total"];
const COUNTS = FIELDS.slice(1);

function describeValue(v) {
  if (v === null || v === undefined) return String(v);
  if (Array.isArray(v)) return `array(length=${v.length})`;
  if (typeof v === "object") return "object";
  if (typeof v === "string") return /^[0-9a-f]{40}$/u.test(v) ? JSON.stringify(v) : `string(length=${v.length})`;
  const s = String(v);
  return s.length <= 32 ? s : `${typeof v}(length=${s.length})`;
}

function serializeFrame(result, subjects, predicate, diagnostic) {
  return JSON.stringify({
    schema: "preset-script-result/v1",
    produces: [
      {
        capabilityId: "completion-witness",
        payload: { result, subjects, predicateType: PREDICATE_TYPE, predicate, diagnostic },
      },
    ],
  });
}

function emit(result, subjects, predicate, diagnostic) {
  let msg = diagnostic;
  let frame = serializeFrame(result, subjects, predicate, msg);
  while (result === "fail" && Buffer.byteLength(frame, "utf8") + 1 > 960 && msg.length > 0) {
    msg = msg.slice(0, Math.max(0, Math.floor(msg.length * 0.75) - 4));
    frame = serializeFrame(result, subjects, predicate, msg ? `${msg}...` : "Invalid verification receipt.");
  }
  console.log(frame);
}

function scanTopLevelDuplicateKeys(raw) {
  const seen = new Set(),
    dups = [];
  let depth = 0,
    strStart = -1,
    escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (strStart >= 0) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        const start = strStart;
        strStart = -1;
        if (depth === 1) {
          let j = i + 1;
          while (j < raw.length && /\s/u.test(raw[j])) j += 1;
          if (raw[j] === ":") {
            const k = JSON.parse(raw.slice(start, i + 1));
            if (seen.has(k) && !dups.includes(k)) dups.push(k);
            seen.add(k);
          }
        }
      }
    } else if (ch === '"') strStart = i;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
  }
  return dups;
}

const witness = JSON.parse(readFileSync(JSON.parse(process.env.HA_PRESET_INPUT ?? "{}").witnessInput, "utf8"));
const subjects = (witness.subjects ?? []).map(({ file: _f, ...id }) => id);
const subject = (witness.subjects ?? []).find((s) => ROOT_RECEIPT.test(s.path));
if (!subject) {
  emit("fail", subjects, {}, "Missing required verification receipt artifact: artifacts/verification-receipt.json.");
  process.exit(0);
}

const rawText = readFileSync(subject.file, "utf8");
const sources = new WeakMap();
let receipt;
try {
  receipt = JSON.parse(rawText, function (k, v, ctx) {
    if (this && typeof this === "object" && typeof ctx?.source === "string") {
      if (!sources.has(this)) sources.set(this, new Map());
      sources.get(this).set(k, ctx.source);
    }
    return v;
  });
} catch (e) {
  emit(
    "fail",
    subjects,
    {},
    `Invalid JSON in artifacts/verification-receipt.json: ${e instanceof Error ? e.message : String(e)}`,
  );
  process.exit(0);
}

if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
  emit("fail", subjects, {}, "artifacts/verification-receipt.json must contain a JSON object.");
  process.exit(0);
}

const errors = scanTopLevelDuplicateKeys(rawText).map((k) => `Duplicate top-level key "${k}" is not allowed.`);
for (const f of FIELDS) if (!Object.hasOwn(receipt, f)) errors.push(`Missing required field "${f}".`);

if (witness.code !== null) {
  const sha = witness.code?.commitSha;
  if (typeof receipt.commitSha !== "string" || receipt.commitSha !== sha)
    errors.push(
      `Receipt commitSha (${describeValue(receipt.commitSha)}) does not match frozen commitSha (${String(sha)}).`,
    );
} else if (Object.hasOwn(receipt, "commitSha") && receipt.commitSha !== null) {
  errors.push(`Artifact-only submission requires commitSha to be null (got ${describeValue(receipt.commitSha)}).`);
}

const rootSrc = sources.get(receipt);
let countsOk = true;
for (const f of COUNTS) {
  if (!Object.hasOwn(receipt, f)) {
    countsOk = false;
    continue;
  }
  const v = receipt[f],
    src = rootSrc?.get(f);
  if (
    !Number.isSafeInteger(v) ||
    v < 0 ||
    (typeof src === "string" && (!/^(?:0|[1-9]\d*)$/u.test(src) || String(v) !== src))
  ) {
    countsOk = false;
    errors.push(
      `Field "${f}" must be a non-negative safe integer (got ${typeof v === "number" && typeof src === "string" && src.length <= 32 ? src : describeValue(v)}).`,
    );
  }
}

if (countsOk) {
  if (receipt.total <= 0) errors.push(`Field "total" must be greater than 0 (got ${receipt.total}).`);
  const sum = receipt.passed + receipt.failed + receipt.timedOut + receipt.unexecuted;
  if (sum !== receipt.total)
    errors.push(
      `Four-state count sum mismatch: passed(${receipt.passed}) + failed(${receipt.failed}) + timedOut(${receipt.timedOut}) + unexecuted(${receipt.unexecuted}) = ${sum} !== total(${receipt.total}).`,
    );
  if (receipt.failed > 0 || receipt.timedOut > 0 || receipt.unexecuted > 0)
    errors.push(
      `Non-passing outcomes present: failed=${receipt.failed}, timedOut=${receipt.timedOut}, unexecuted=${receipt.unexecuted} (all must be 0).`,
    );
}

if (errors.length > 0) emit("fail", subjects, {}, errors.join(" "));
else
  emit(
    "pass",
    subjects,
    Object.fromEntries(FIELDS.map((f) => [f, receipt[f]])),
    "Verification receipt verified: commitSha and four-state counts match frozen cut.",
  );
