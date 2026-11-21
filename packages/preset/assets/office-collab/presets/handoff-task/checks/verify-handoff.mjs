import { hash } from "node:crypto";
import { readFileSync } from "node:fs";

const PREDICATE_TYPE = "office-collab/handoff-completeness/v1";
const SCHEMA_ID = "office-collab/handoff/v1";
const MANIFEST_PATH = "artifacts/handoff.json";
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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
if (!isRecord(manifest)) {
  emit("fail", subjects, {}, `${MANIFEST_PATH} must be a JSON object.`);
  process.exit(0);
}

const errors = scanDuplicateTopLevelKeys(rawManifest).map((key) => `Duplicate top-level key "${key}".`);
if (manifest.schema !== SCHEMA_ID) errors.push(`schema must equal "${SCHEMA_ID}".`);

// Element 1: ownerTransfer (from, to, effectiveAt)
if (!isRecord(manifest.ownerTransfer)) {
  errors.push('Missing handoff element "ownerTransfer".');
} else {
  if (!nonEmptyString(manifest.ownerTransfer.from)) errors.push('Missing non-empty "ownerTransfer.from".');
  if (!nonEmptyString(manifest.ownerTransfer.to)) errors.push('Missing non-empty "ownerTransfer.to".');
  if (!nonEmptyString(manifest.ownerTransfer.effectiveAt))
    errors.push('Missing non-empty "ownerTransfer.effectiveAt".');
}

// Element 2: deliverables (non-empty list with verified artifact presence & SHA-256)
const seenPaths = new Set();
if (!Array.isArray(manifest.deliverables) || manifest.deliverables.length === 0) {
  errors.push('Missing handoff element "deliverables" (must be a non-empty array).');
} else {
  for (const [index, item] of manifest.deliverables.entries()) {
    if (!isRecord(item)) {
      errors.push(`deliverables[${index}] must be an object.`);
      continue;
    }
    if (typeof item.path !== "string" || !SAFE_ARTIFACT.test(item.path)) {
      errors.push(`deliverables[${index}].path must be a safe artifacts/... relative path.`);
      continue;
    }
    if (seenPaths.has(item.path)) {
      errors.push(`Duplicate deliverable path "${item.path}".`);
      continue;
    }
    seenPaths.add(item.path);
    if (!nonEmptyString(item.summary)) errors.push(`deliverables[${index}].summary must be a non-empty string.`);
    if (typeof item.sha256 !== "string" || !SHA256_RE.test(item.sha256)) {
      errors.push(`deliverables[${index}].sha256 must be a 64-character lowercase SHA-256 hex digest.`);
      continue;
    }
    const targetSubject = findRootSubject(rawSubjects, item.path);
    if (!targetSubject) {
      errors.push(`Deliverable "${item.path}" is absent from submitted artifacts.`);
      continue;
    }
    const actualSha256 = hash("sha256", readFileSync(targetSubject.file), "hex");
    if (actualSha256 !== item.sha256)
      errors.push(
        `Deliverable hash mismatch for "${item.path}": expected ${item.sha256.slice(0, 12)}, got ${actualSha256.slice(0, 12)}.`,
      );
  }
}

// Element 3: openItems (explicit array of tracked open follow-ups)
if (!Array.isArray(manifest.openItems)) {
  errors.push('Missing handoff element "openItems" (must be an array).');
} else {
  for (const [index, item] of manifest.openItems.entries()) {
    if (!isRecord(item)) {
      errors.push(`openItems[${index}] must be an object.`);
      continue;
    }
    for (const field of ["id", "summary", "owner", "nextAction"]) {
      if (!nonEmptyString(item[field])) errors.push(`openItems[${index}].${field} must be a non-empty string.`);
    }
  }
}

// Element 4: acceptanceCriteria (non-empty list of explicit takeover criteria)
if (!Array.isArray(manifest.acceptanceCriteria) || manifest.acceptanceCriteria.length === 0) {
  errors.push('Missing handoff element "acceptanceCriteria" (must be a non-empty array).');
} else if (!manifest.acceptanceCriteria.every(nonEmptyString)) {
  errors.push('Field "acceptanceCriteria" entries must be non-empty strings.');
}

// Optional risks validation when supplied
if (manifest.risks !== undefined) {
  if (!Array.isArray(manifest.risks)) {
    errors.push('Optional field "risks" must be an array.');
  } else {
    for (const [index, item] of manifest.risks.entries()) {
      if (!isRecord(item) || !nonEmptyString(item.summary) || !nonEmptyString(item.mitigation))
        errors.push(`risks[${index}] must declare non-empty summary and mitigation.`);
    }
  }
}

if (errors.length > 0) {
  emit("fail", subjects, {}, errors.join(" "));
} else {
  emit(
    "pass",
    subjects,
    {
      schema: manifest.schema,
      from: manifest.ownerTransfer.from,
      to: manifest.ownerTransfer.to,
      deliverableCount: manifest.deliverables.length,
      openItemCount: manifest.openItems.length,
      acceptanceCriteriaCount: manifest.acceptanceCriteria.length,
      allElementsPresent: true,
    },
    "Handoff four-element completeness and deliverable integrity verified.",
  );
}
