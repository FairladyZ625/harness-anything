import { hash } from "node:crypto";
import { readFileSync } from "node:fs";

const PREDICATE_TYPE = "office-collab/upstream-fresh/v1";
const SCHEMA_ID = "office-collab/upstream-freshness/v1";
const MANIFEST_PATH = "artifacts/upstream-freshness.json";
const SHA256_RE = /^[0-9a-f]{64}$/u;
const SAFE_ARTIFACT = /^artifacts\/(?:(?!\.\.?\/)[^/\\]+\/)*(?!\.\.?$)[^/\\]+$/u;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function findRootSubject(subjects, logicalPath) {
  const pattern = new RegExp(`^(?:(?!artifacts\\/)[^/]+\\/)*${escapeRegex(logicalPath)}$`, "u");
  return subjects.find((item) => typeof item?.path === "string" && pattern.test(item.path));
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function scanDuplicateTopLevelKeys(raw) {
  const seen = new Set();
  const duplicates = [];
  for (let i = 0, depth = 0, strStart = -1, escaped = false; i < raw.length; i += 1) {
    const ch = raw[i];
    if (strStart >= 0) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        if (depth === 1) {
          let j = i + 1;
          while (/\s/u.test(raw[j] ?? "")) j += 1;
          if (raw[j] === ":") {
            const key = JSON.parse(raw.slice(strStart, i + 1));
            if (seen.has(key) && !duplicates.includes(key)) duplicates.push(key);
            seen.add(key);
          }
        }
        strStart = -1;
      }
    } else if (ch === '"') strStart = i;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
  }
  return duplicates;
}

function emit(result, subjects, predicate, diagnostic) {
  const frame = (message) =>
    JSON.stringify({
      schema: "preset-script-result/v1",
      produces: [
        {
          capabilityId: "completion-witness",
          payload: {
            result,
            subjects,
            predicateType: PREDICATE_TYPE,
            predicate,
            diagnostic: message,
          },
        },
      ],
    });
  let message = diagnostic;
  let output = frame(message);
  while (result === "fail" && Buffer.byteLength(output) > 959 && message) {
    message = message.slice(0, Math.floor(message.length * 0.7));
    output = frame(message ? `${message}...` : "Invalid.");
  }
  console.log(output);
}

const inputPath = JSON.parse(process.env.HA_PRESET_INPUT ?? "{}").witnessInput;
const witness = JSON.parse(readFileSync(inputPath, "utf8"));
const rawSubjects = Array.isArray(witness.subjects) ? witness.subjects : [];
const readableArtifacts = Array.isArray(witness.artifacts) ? witness.artifacts : rawSubjects;
const subjects = rawSubjects.map(({ file: _file, ...identity }) => identity);

const manifestSubject = findRootSubject(rawSubjects, MANIFEST_PATH);
if (!manifestSubject) {
  emit("fail", subjects, {}, `Missing required artifact ${MANIFEST_PATH}.`);
  process.exit(0);
}

const rawManifest = readFileSync(manifestSubject.file, "utf8");
let manifest;
try {
  manifest = JSON.parse(rawManifest);
} catch (error) {
  emit("fail", subjects, {}, `Invalid JSON in ${MANIFEST_PATH}: ${error?.message ?? error}`);
  process.exit(0);
}
if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
  emit("fail", subjects, {}, `${MANIFEST_PATH} must be a JSON object.`);
  process.exit(0);
}

const errors = scanDuplicateTopLevelKeys(rawManifest).map((key) => `Duplicate top-level key "${key}".`);
if (manifest.schema !== SCHEMA_ID) errors.push(`schema must equal "${SCHEMA_ID}".`);
if (!nonEmptyString(manifest.checkedAt)) errors.push('Missing non-empty "checkedAt".');
if (!Array.isArray(manifest.baselines) || manifest.baselines.length === 0)
  errors.push('Field "baselines" must be a non-empty array.');

let driftedCount = 0;
const seenRefs = new Set();

if (Array.isArray(manifest.baselines)) {
  for (const [index, entry] of manifest.baselines.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`baselines[${index}] must be an object.`);
      continue;
    }
    if (!nonEmptyString(entry.ref)) {
      errors.push(`baselines[${index}].ref must be a non-empty string.`);
      continue;
    }
    const ref = entry.ref.trim();
    if (seenRefs.has(ref)) {
      errors.push(`Duplicate upstream baseline ref "${ref}".`);
      continue;
    }
    seenRefs.add(ref);
    if (typeof entry.expectedSha256 !== "string" || !SHA256_RE.test(entry.expectedSha256)) {
      errors.push(`baselines[${index}].expectedSha256 must be a 64-character lowercase SHA-256 hex digest.`);
      continue;
    }
    if (!ref.startsWith("artifacts/")) {
      driftedCount += 1;
      errors.push(
        `Unverifiable external upstream ref "${ref}": upstream-fresh only verifies frozen artifacts/... subjects whose bytes can be independently hashed.`,
      );
      continue;
    }
    if (!SAFE_ARTIFACT.test(ref)) {
      driftedCount += 1;
      errors.push(`baselines[${index}].ref "${ref}" is not a safe artifacts/... path.`);
      continue;
    }
    const subject = findRootSubject(readableArtifacts, ref);
    if (!subject) {
      driftedCount += 1;
      errors.push(`Upstream artifact "${ref}" is missing from submitted artifacts.`);
      continue;
    }
    const actualSha256 = hash("sha256", readFileSync(subject.file), "hex");
    if (actualSha256 !== entry.expectedSha256) {
      driftedCount += 1;
      errors.push(
        `Upstream drift on "${ref}": expected ${entry.expectedSha256.slice(0, 12)}, actual ${actualSha256.slice(0, 12)}.`,
      );
    } else if (entry.observedSha256 !== undefined) {
      if (typeof entry.observedSha256 !== "string" || !SHA256_RE.test(entry.observedSha256)) {
        errors.push(`baselines[${index}].observedSha256 must be a 64-character lowercase SHA-256 hex digest.`);
      } else if (entry.observedSha256 !== actualSha256) {
        driftedCount += 1;
        errors.push(`Upstream observedSha256 disagrees with frozen bytes for "${ref}".`);
      }
    }
  }
}

if (errors.length > 0 || driftedCount > 0) {
  emit("fail", subjects, {}, errors.join(" "));
} else {
  emit(
    "pass",
    subjects,
    {
      schema: manifest.schema,
      checkedAt: manifest.checkedAt,
      baselineCount: manifest.baselines.length,
      driftedCount: 0,
      allFresh: true,
    },
    `Verified ${manifest.baselines.length} upstream baseline(s) with zero drift.`,
  );
}
