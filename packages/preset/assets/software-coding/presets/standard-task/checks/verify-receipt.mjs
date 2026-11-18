import { readFileSync } from "node:fs";

const ROOT = /^(?:(?!artifacts\/)[^/]+\/)*artifacts\/verification-receipt\.json$/u;
const KEYS = ["commitSha", "passed", "failed", "timedOut", "unexecuted", "total"];

const desc = (v) =>
  Array.isArray(v)
    ? `array(length=${v.length})`
    : v && typeof v === "object"
      ? "object"
      : typeof v === "string"
        ? `len=${v.length}`
        : String(v).slice(0, 32);

function emit(result, subjects, predicate, msg) {
  const frame = (d) =>
    JSON.stringify({
      schema: "preset-script-result/v1",
      produces: [
        {
          capabilityId: "completion-witness",
          payload: {
            result,
            subjects,
            predicateType: "software-coding/verification-receipt/v1",
            predicate,
            diagnostic: d,
          },
        },
      ],
    });
  let m = msg,
    f = frame(m);
  while (result === "fail" && Buffer.byteLength(f) > 959 && m) {
    m = m.slice(0, Math.floor(m.length * 0.7));
    f = frame(m ? `${m}...` : "Invalid.");
  }
  console.log(f);
}

function scanTop(raw) {
  const seen = new Set(),
    dups = [],
    tok = new Map();
  for (let i = 0, d = 0, s = -1, esc = false; i < raw.length; i++) {
    const c = raw[i];
    if (s >= 0) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') {
        if (d === 1) {
          let j = i + 1;
          while (/\s/u.test(raw[j] ?? "")) j++;
          if (raw[j] === ":") {
            const k = JSON.parse(raw.slice(s, i + 1));
            if (seen.has(k) && !dups.includes(k)) dups.push(k);
            seen.add(k);
            for (j++; /\s/u.test(raw[j] ?? ""); ) j++;
            if (j < raw.length && !'{["'.includes(raw[j])) {
              let e = j;
              while (e < raw.length && !",}\r\n\t ".includes(raw[e])) e++;
              tok.set(k, raw.slice(j, e));
            }
          }
        }
        s = -1;
      }
    } else if (c === '"') s = i;
    else if (c === "{" || c === "[") d++;
    else if (c === "}" || c === "]") d--;
  }
  return { dups, tok };
}

function exactInt(v, src) {
  if (!Number.isSafeInteger(v) || v < 0) return false;
  if (typeof src !== "string") return true;
  const m = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(src);
  if (!m) return false;
  let d = (m[2] + (m[3] ?? "")).replace(/^0+(?=\d)/u, ""),
    e = Number(m[4] ?? 0) - (m[3]?.length ?? 0);
  if (d === "0") return v === 0;
  if (m[1] === "-") return false;
  for (; d.endsWith("0"); e++) d = d.slice(0, -1);
  return e >= 0 && e <= 16 && BigInt(d) * 10n ** BigInt(e) === BigInt(v);
}

const w = JSON.parse(readFileSync(JSON.parse(process.env.HA_PRESET_INPUT ?? "{}").witnessInput, "utf8"));
const subjects = (w.subjects ?? []).map(({ file: _f, ...id }) => id);
const sub = (w.subjects ?? []).find((x) => ROOT.test(x.path));
if (!sub) {
  emit("fail", subjects, {}, "Missing required verification receipt artifact.");
  process.exit(0);
}

const raw = readFileSync(sub.file, "utf8");
let r;
try {
  r = JSON.parse(raw);
} catch (e) {
  emit("fail", subjects, {}, `Invalid JSON: ${e?.message ?? e}`);
  process.exit(0);
}
if (!r || typeof r !== "object" || Array.isArray(r)) {
  emit("fail", subjects, {}, "Not a JSON object.");
  process.exit(0);
}

const { dups, tok } = scanTop(raw);
const errs = dups.map((k) => `Duplicate top-level key "${k}".`);
for (const k of KEYS) if (!Object.hasOwn(r, k)) errs.push(`Missing "${k}".`);

if (w.code !== null) {
  if (r.commitSha !== w.code?.commitSha) errs.push(`${desc(r.commitSha)} does not match frozen commitSha.`);
} else if (Object.hasOwn(r, "commitSha") && r.commitSha !== null)
  errs.push(`commitSha must be null (${desc(r.commitSha)}).`);

let ok = true;
for (const k of KEYS.slice(1)) {
  if (!Object.hasOwn(r, k)) ok = false;
  else if (!exactInt(r[k], tok.get(k))) {
    ok = false;
    const t = tok.get(k);
    errs.push(`Bad "${k}" (${t && t.length <= 32 ? t : desc(r[k])}).`);
  }
}

if (ok) {
  if (r.total <= 0) errs.push("total <= 0.");
  const s = r.passed + r.failed + r.timedOut + r.unexecuted;
  if (s !== r.total) errs.push(`Four-state count sum mismatch: sum = ${s} !== total(${r.total}).`);
  if (r.failed || r.timedOut || r.unexecuted)
    errs.push(`Non-passing outcomes present: failed=${r.failed}, timedOut=${r.timedOut}, unexecuted=${r.unexecuted}.`);
}

if (errs.length) emit("fail", subjects, {}, errs.join(" "));
else emit("pass", subjects, Object.fromEntries(KEYS.map((k) => [k, r[k]])), "OK");
